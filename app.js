const defaultView = {
  lat: 25.033964,
  lng: 121.564468,
  zoom: 13,
};

const STORAGE_KEY = "fog-of-world-web-state";
const DEFAULT_REVEAL_RADIUS_METERS = 90;
const IMPORT_REVEAL_RADIUS_METERS = 110;
const LIVE_REVEAL_RADIUS_METERS = 95;
const MAX_IMPORT_SEGMENT_METERS = 10000;
const MAX_ACCEPTABLE_ACCURACY_METERS = 100;
const MIN_POINT_SPACING_METERS = 35;

const WORLD_MASK_WIDTH = 2048;
const WORLD_MASK_HEIGHT = 1024;
const WORLD_MASK_NORTH = 85;
const WORLD_MASK_SOUTH = -85;
const FOG_WORLD_PIXEL_ZOOM = 20;
const FOG_CELL_DIVISOR = 64;
const FOG_DOCUMENT_SIZE_CELLS = 8192;
const FOG_BLOCK_SIZE_CELLS = 64;
const FOG_BLOCKS_PER_DOCUMENT = 128;
const FOG_DOCUMENTS_PER_ROW = 512;
const SYNC_PAGE_SIZE_BYTES = 256;
const SYNC_ROOT_PAGE_COUNT = 128;
const SYNC_ROOT_GRID_SIZE = 128;
const SYNC_LEAF_PAGES_PER_BLOCK = 2;
const SYNC_BLOCK_SIZE_BITS = 64;
const SYNC_HALF_BLOCK_ROWS = 32;

const SYNC_MIN_DOCUMENTS = 9;
const SYNC_DOCUMENT_CANVAS_SIZE = 1024;
const TAIWAN_SYNC_ANCHOR = {
  documentX: 426,
  documentY: 219,
};

const statusEl = document.querySelector("#status");
const locateBtn = document.querySelector("#locateBtn");
const trackBtn = document.querySelector("#trackBtn");
const importBtn = document.querySelector("#importBtn");
const syncBtn = document.querySelector("#syncBtn");
const clearBtn = document.querySelector("#clearBtn");
const fileInput = document.querySelector("#fileInput");
const syncInput = document.querySelector("#syncInput");

let map;
let routeLayer;
let fogLayer;
let marker;
let watchId = null;
let liveRoute = null;
let syncWorldMask = null;

const state = loadState();

function initializeApp() {
  map = L.map("map", {
    zoomControl: true,
  }).setView([defaultView.lat, defaultView.lng], defaultView.zoom);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  routeLayer = L.layerGroup().addTo(map);
  fogLayer = new FogLayer([], null);
  fogLayer.addTo(map);

  bindEvents();
  redrawRoutesAndFog();
  updateTrackButton();
  setStatus("Fog of World 風格迷霧已啟用。可追蹤即時移動、匯入 GPX/KML，或實驗性匯入 Sync。");
}

function bindEvents() {
  locateBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      setStatus("你的瀏覽器不支援定位。");
      return;
    }

    setStatus("正在取得目前位置...");

    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const point = [coords.latitude, coords.longitude];
        map.setView(point, 16);
        updateMarker(point, "你的目前位置");
        appendPointToRoute(ensureLiveRoute(), point);
        setStatus(`已加入目前位置。精度約 ${Math.round(coords.accuracy)} 公尺。`);
      },
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? "定位權限被拒絕。"
            : "無法取得位置。";
        setStatus(message);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
      },
    );
  });

  trackBtn.addEventListener("click", () => {
    if (watchId === null) {
      startLiveTracking();
    } else {
      stopLiveTracking();
    }
  });

  importBtn.addEventListener("click", () => {
    fileInput.click();
  });

  syncBtn.addEventListener("click", () => {
    syncInput.click();
  });

  clearBtn.addEventListener("click", () => {
    state.routes = [];
    liveRoute = null;
    syncWorldMask = null;
    persistState();
    redrawRoutesAndFog();

    if (marker) {
      map.removeLayer(marker);
      marker = null;
    }

    setStatus("已清除網頁版紀錄與本次 Sync 匯入結果。");
  });

  fileInput.addEventListener("change", async (event) => {
    const [file] = event.target.files ?? [];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const importedRoutes = importTrackFile(file.name, text);

      if (importedRoutes.length === 0) {
        setStatus("沒有找到可匯入的有效軌跡。");
        return;
      }

      state.routes.push(...importedRoutes);
      persistState();
      redrawRoutesAndFog();
      fitToRoutes(importedRoutes);

      const importedPoints = importedRoutes.reduce((sum, route) => sum + route.points.length, 0);
      setStatus(`已匯入 ${importedRoutes.length} 條軌跡，共 ${importedPoints} 個點。超過 10km 的跳點已忽略。`);
    } catch (error) {
      setStatus(`匯入失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    } finally {
      fileInput.value = "";
    }
  });

  syncInput.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) {
      return;
    }

    try {
      setStatus(`正在分析 ${files.length} 個 Sync 檔案...`);
      const result = await importSyncDirectory(files);
      syncWorldMask = result.canvas;
      redrawRoutesAndFog();

      if (result.summary.bounds) {
        map.fitBounds(
          [
            [result.summary.bounds.south, result.summary.bounds.west],
            [result.summary.bounds.north, result.summary.bounds.east],
          ],
          { padding: [24, 24], maxZoom: 9 },
        );
      }

      const labels = result.summary.documents.map((item) => item.label).join("、");
      setStatus(`已用 root/leaf page tree 還原 Sync：${labels}。目前改用相鄰 document 格網推定位置，已不再套用 continent heuristic。`);
    } catch (error) {
      setStatus(`Sync 匯入失敗：${error instanceof Error ? error.message : "未知錯誤"}`);
    } finally {
      syncInput.value = "";
    }
  });
}

let FogLayer = null;

if (window.L) {
  FogLayer = L.Layer.extend({
    initialize(reveals = [], syncMask = null) {
      this.reveals = reveals;
      this.syncMask = syncMask;
    },

    onAdd(activeMap) {
      this._map = activeMap;
      this._canvas = L.DomUtil.create("canvas", "leaflet-fog-layer");
      this._canvas.style.pointerEvents = "none";
      this._ctx = this._canvas.getContext("2d");

      activeMap.getPanes().overlayPane.appendChild(this._canvas);
      activeMap.on("move zoom resize", this._reset, this);
      this._reset();
    },

    onRemove(activeMap) {
      activeMap.off("move zoom resize", this._reset, this);
      L.DomUtil.remove(this._canvas);
    },

    setReveals(reveals) {
      this.reveals = reveals;
      this._redraw();
    },

    setSyncMask(syncMask) {
      this.syncMask = syncMask;
      this._redraw();
    },

    _reset() {
      const size = this._map.getSize();
      const topLeft = this._map.containerPointToLayerPoint([0, 0]);

      L.DomUtil.setPosition(this._canvas, topLeft);
      this._canvas.width = size.x;
      this._canvas.height = size.y;
      this._redraw();
    },

    _redraw() {
      if (!this._ctx) {
        return;
      }

      const ctx = this._ctx;
      const { width, height } = this._canvas;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "rgba(6, 10, 8, 0.9)";
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = "destination-out";

      if (this.syncMask) {
        this._drawSyncMask(ctx);
      }

      for (const reveal of this.reveals) {
        const center = L.latLng(reveal.lat, reveal.lng);
        const point = this._map.latLngToContainerPoint(center);
        const radius = this._metersToPixels(center, reveal.radius);
        const glowRadius = radius * 1.35;

        const gradient = ctx.createRadialGradient(
          point.x,
          point.y,
          Math.max(radius * 0.35, 1),
          point.x,
          point.y,
          glowRadius,
        );

        gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
        gradient.addColorStop(0.72, "rgba(0, 0, 0, 0.92)");
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(point.x, point.y, glowRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = "source-over";
    },

    _drawSyncMask(ctx) {
      const source = this.syncMask;
      const rowLatitudeSpan = (WORLD_MASK_NORTH - WORLD_MASK_SOUTH) / source.height;
      const left = this._map.latLngToContainerPoint([0, -180]).x;
      const right = this._map.latLngToContainerPoint([0, 180]).x;
      const drawWidth = right - left;

      if (!Number.isFinite(left) || !Number.isFinite(right) || drawWidth === 0) {
        return;
      }

      for (let row = 0; row < source.height; row += 1) {
        const latTop = WORLD_MASK_NORTH - row * rowLatitudeSpan;
        const latBottom = latTop - rowLatitudeSpan;
        const y1 = this._map.latLngToContainerPoint([latTop, 0]).y;
        const y2 = this._map.latLngToContainerPoint([latBottom, 0]).y;
        const top = Math.min(y1, y2);
        const drawHeight = Math.max(Math.abs(y2 - y1), 1);

        if (top > this._canvas.height || top + drawHeight < 0) {
          continue;
        }

        ctx.drawImage(source, 0, row, source.width, 1, left, top, drawWidth, drawHeight);
      }
    },

    _metersToPixels(center, meters) {
      const bounds = center.toBounds(meters * 2);
      const northEastPoint = this._map.latLngToContainerPoint(bounds.getNorthEast());
      const centerPoint = this._map.latLngToContainerPoint(center);
      return Math.max(Math.abs(northEastPoint.x - centerPoint.x), 14);
    },
  });
}

if (!window.L) {
  disableControls();
  setStatus("Leaflet 載入失敗，地圖沒有初始化。最常見原因是 CDN 無法連線。");
} else {
  initializeApp();
}

function disableControls() {
  for (const element of [locateBtn, trackBtn, importBtn, syncBtn, clearBtn]) {
    if (element) {
      element.disabled = true;
    }
  }
}

function startLiveTracking() {
  if (!navigator.geolocation) {
    setStatus("你的瀏覽器不支援持續定位。");
    return;
  }

  liveRoute = ensureLiveRoute();

  watchId = navigator.geolocation.watchPosition(
    ({ coords }) => {
      if (coords.accuracy > MAX_ACCEPTABLE_ACCURACY_METERS) {
        setStatus(`忽略本次定位，精度 ${Math.round(coords.accuracy)} 公尺，超過 ${MAX_ACCEPTABLE_ACCURACY_METERS} 公尺門檻。`);
        return;
      }

      const point = [coords.latitude, coords.longitude];
      const appended = appendPointToRoute(liveRoute, point);

      if (!appended) {
        return;
      }

      updateMarker(point, "正在追蹤");
      map.panTo(point, { animate: true });
      setStatus(`追蹤中。已記錄點位，精度 ${Math.round(coords.accuracy)} 公尺。`);
    },
    (error) => {
      const message =
        error.code === error.PERMISSION_DENIED
          ? "追蹤被拒絕，請允許定位權限。"
          : "追蹤失敗。";
      setStatus(message);
      stopLiveTracking();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15000,
    },
  );

  updateTrackButton();
  setStatus("開始追蹤。會依移動路徑連續揭露迷霧。");
}

function stopLiveTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  liveRoute = null;
  updateTrackButton();
  setStatus("已停止追蹤。");
}

function ensureLiveRoute() {
  if (liveRoute) {
    return liveRoute;
  }

  const route = {
    id: crypto.randomUUID(),
    source: "live",
    color: "#ff6b35",
    points: [],
  };

  state.routes.push(route);
  persistState();
  liveRoute = route;
  return route;
}

function appendPointToRoute(route, point) {
  const previousPoint = route.points.at(-1);
  if (previousPoint) {
    const distance = distanceMeters(previousPoint, point);
    if (distance < MIN_POINT_SPACING_METERS) {
      return false;
    }
  }

  route.points.push(point);
  persistState();
  redrawRoutesAndFog();
  return true;
}

function redrawRoutesAndFog() {
  if (!routeLayer || !fogLayer) {
    return;
  }

  routeLayer.clearLayers();
  const reveals = [];

  for (const route of state.routes) {
    if (!Array.isArray(route.points) || route.points.length === 0) {
      continue;
    }

    const latLngs = route.points.map(([lat, lng]) => L.latLng(lat, lng));

    if (latLngs.length >= 2) {
      L.polyline(latLngs, {
        color: route.color ?? "#f4c95d",
        weight: 4,
        opacity: 0.9,
      }).addTo(routeLayer);
    }

    reveals.push(...buildRevealSamples(route.points, resolveRouteRadius(route)));
  }

  fogLayer.setSyncMask(syncWorldMask);
  fogLayer.setReveals(reveals);
}

function buildRevealSamples(points, radius) {
  const reveals = [];
  if (points.length === 0) {
    return reveals;
  }

  reveals.push(toReveal(points[0], radius));

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentDistance = distanceMeters(start, end);

    if (segmentDistance <= 0) {
      continue;
    }

    const stepMeters = Math.max(radius * 0.45, 24);
    const steps = Math.max(1, Math.ceil(segmentDistance / stepMeters));

    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      reveals.push(
        toReveal(
          [
            start[0] + (end[0] - start[0]) * t,
            start[1] + (end[1] - start[1]) * t,
          ],
          radius,
        ),
      );
    }
  }

  return reveals;
}

function toReveal(point, radius) {
  return {
    lat: point[0],
    lng: point[1],
    radius,
  };
}

function resolveRouteRadius(route) {
  return route.source === "import" ? IMPORT_REVEAL_RADIUS_METERS : DEFAULT_REVEAL_RADIUS_METERS;
}

function updateMarker(point, label) {
  if (!marker) {
    marker = L.marker(point).addTo(map);
  } else {
    marker.setLatLng(point);
  }

  marker.bindPopup(label).openPopup();
}

function updateTrackButton() {
  if (trackBtn) {
    trackBtn.textContent = watchId === null ? "開始追蹤" : "停止追蹤";
  }
}

function setStatus(message) {
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function fitToRoutes(routes) {
  const boundsPoints = routes.flatMap((route) => route.points);
  if (boundsPoints.length === 0) {
    return;
  }

  map.fitBounds(boundsPoints, {
    padding: [36, 36],
    maxZoom: 15,
  });
}

function importTrackFile(filename, text) {
  const lowerName = filename.toLowerCase();
  if (lowerName.endsWith(".gpx")) {
    return parseGpx(text);
  }
  if (lowerName.endsWith(".kml")) {
    return parseKml(text);
  }

  throw new Error("目前只支援 GPX 與 KML。");
}

async function importSyncDirectory(files) {
  const decodedFiles = [];

  for (const file of files) {
    if (file.name.startsWith(".")) {
      continue;
    }

    const compressed = new Uint8Array(await file.arrayBuffer());
    let decompressed;

    try {
      decompressed = await inflateZlib(compressed);
    } catch {
      continue;
    }

    decodedFiles.push({
      name: file.name,
      bytes: decompressed,
    });
  }

  if (decodedFiles.length < SYNC_MIN_DOCUMENTS) {
    throw new Error(`可解壓的 Sync 檔案不足。預期至少 ${SYNC_MIN_DOCUMENTS} 個 zlib 檔案。`);
  }

  const parsedDocuments = decodedFiles
    .map((file) => ({
      ...file,
      decoded: decodeSyncPageTree(file.bytes),
    }))
    .filter((file) => file.decoded.refCount > 0)
    .sort((left, right) => right.decoded.refCount - left.decoded.refCount);

  if (parsedDocuments.length < SYNC_MIN_DOCUMENTS) {
    throw new Error("目前至少需要 9 份可解析的 Sync documents。");
  }
  const relativeLayout = inferRelativeSyncLayout(parsedDocuments);
  const placedDocuments = assignSyncDocumentsToGrid(relativeLayout, TAIWAN_SYNC_ANCHOR);

  const canvas = document.createElement("canvas");
  canvas.width = WORLD_MASK_WIDTH;
  canvas.height = WORLD_MASK_HEIGHT;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("無法建立遮罩畫布。");
  }

  const summary = {
    documents: [],
    bounds: null,
  };

  let combinedBounds = null;

  for (const file of placedDocuments) {
    const bounds = fogDocumentToBounds(file.documentX, file.documentY);
    const packedBitmap = renderSyncDocumentMask(file.decoded);

    drawSyncDocumentToWorldMask(ctx, packedBitmap, bounds);
    combinedBounds = extendBounds(combinedBounds, bounds);

    summary.documents.push({
      label: `${file.name} -> doc(${file.documentX},${file.documentY})`,
      filename: file.name,
      bytes: file.bytes.length,
      refs: file.decoded.refCount,
      occupiedBlocks: file.decoded.occupiedBlocks,
      blockBounds: file.decoded.blockBounds,
      remainder: file.decoded.remainderBytes,
      trailingPages: file.decoded.trailingPages,
      relativeGrid: { x: file.relativeX, y: file.relativeY },
      documentGrid: { x: file.documentX, y: file.documentY },
      bounds,
    });
  }

  summary.bounds = combinedBounds;
  return { canvas, summary };
}

async function inflateZlib(bytes) {
  if (typeof window.pako?.inflate === "function") {
    return window.pako.inflate(bytes);
  }

  if (typeof DecompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    const response = new Response(stream);
    return new Uint8Array(await response.arrayBuffer());
  }

  throw new Error("瀏覽器不支援 zlib 解壓，且 pako 未載入。");
}

function decodeSyncPageTree(bytes) {
  const fullPageCount = Math.floor(bytes.length / SYNC_PAGE_SIZE_BYTES);
  if (fullPageCount < SYNC_ROOT_PAGE_COUNT) {
    throw new Error("Sync 檔案頁數不足，無法解析 root index。");
  }

  const rootBytes = bytes.subarray(0, SYNC_ROOT_PAGE_COUNT * SYNC_PAGE_SIZE_BYTES);
  const rootIndex = new Uint16Array(SYNC_ROOT_GRID_SIZE * SYNC_ROOT_GRID_SIZE);
  const references = new Set();
  const blockBounds = {
    minX: SYNC_ROOT_GRID_SIZE - 1,
    minY: SYNC_ROOT_GRID_SIZE - 1,
    maxX: 0,
    maxY: 0,
  };
  let blockSumX = 0;
  let blockSumY = 0;

  for (let valueIndex = 0; valueIndex < rootIndex.length; valueIndex += 1) {
    const byteOffset = valueIndex * 2;
    const reference = rootBytes[byteOffset] | (rootBytes[byteOffset + 1] << 8);
    rootIndex[valueIndex] = reference;

    if (reference === 0) {
      continue;
    }

    references.add(reference);
    const blockX = valueIndex % SYNC_ROOT_GRID_SIZE;
    const blockY = Math.floor(valueIndex / SYNC_ROOT_GRID_SIZE);
    blockSumX += blockX;
    blockSumY += blockY;
    blockBounds.minX = Math.min(blockBounds.minX, blockX);
    blockBounds.minY = Math.min(blockBounds.minY, blockY);
    blockBounds.maxX = Math.max(blockBounds.maxX, blockX);
    blockBounds.maxY = Math.max(blockBounds.maxY, blockY);
  }

  const refCount = references.size;
  const occupiedBlocks = rootIndex.reduce((count, reference) => count + (reference > 0 ? 1 : 0), 0);
  const payloadPages = refCount * SYNC_LEAF_PAGES_PER_BLOCK;
  const trailingPages = Math.max(0, fullPageCount - SYNC_ROOT_PAGE_COUNT - payloadPages);

  return {
    rootIndex,
    refCount,
    occupiedBlocks,
    blockBounds: refCount === 0 ? null : blockBounds,
    blockCentroid:
      occupiedBlocks === 0
        ? null
        : {
            x: blockSumX / occupiedBlocks,
            y: blockSumY / occupiedBlocks,
          },
    trailingPages,
    remainderBytes: bytes.length - fullPageCount * SYNC_PAGE_SIZE_BYTES,
    pageBytes: bytes.subarray(0, fullPageCount * SYNC_PAGE_SIZE_BYTES),
  };
}

function inferRelativeSyncLayout(parsedDocuments) {
  const edgeScores = buildSyncEdgeScores(parsedDocuments);
  const byName = new Map(parsedDocuments.map((file) => [file.name, file]));
  const occupied = new Map();
  const placed = new Map();
  const remaining = new Set(parsedDocuments.map((file) => file.name));
  const start = [...parsedDocuments].sort((left, right) => right.decoded.refCount - left.decoded.refCount)[0];

  placed.set(start.name, { x: 0, y: 0 });
  occupied.set("0,0", start.name);
  remaining.delete(start.name);

  while (remaining.size > 0) {
    let bestCandidate = null;

    for (const name of remaining) {
      const neighbors = edgeScores.get(name) ?? [];
      const candidateCells = new Set();

      for (const link of neighbors) {
        const anchor = placed.get(link.target);
        if (!anchor) {
          continue;
        }

        const candidate = shiftPoint(anchor, oppositeDirection(link.direction));
        if (!occupied.has(`${candidate.x},${candidate.y}`)) {
          candidateCells.add(`${candidate.x},${candidate.y}`);
        }
      }

      if (candidateCells.size === 0) {
        for (const anchor of placed.values()) {
          for (const direction of ["north", "south", "west", "east"]) {
            const candidate = shiftPoint(anchor, direction);
            if (!occupied.has(`${candidate.x},${candidate.y}`)) {
              candidateCells.add(`${candidate.x},${candidate.y}`);
            }
          }
        }
      }

      for (const key of candidateCells) {
        const [xText, yText] = key.split(",");
        const candidate = { x: Number(xText), y: Number(yText) };
        const score = scoreSyncPlacement(name, candidate, placed, edgeScores);

        if (!bestCandidate || score > bestCandidate.score) {
          bestCandidate = { name, candidate, score };
        }
      }
    }

    if (!bestCandidate) {
      break;
    }

    placed.set(bestCandidate.name, bestCandidate.candidate);
    occupied.set(`${bestCandidate.candidate.x},${bestCandidate.candidate.y}`, bestCandidate.name);
    remaining.delete(bestCandidate.name);
  }

  const normalized = normalizeRelativeLayout(placed);
  return [...normalized.entries()]
    .map(([name, position]) => ({
      ...byName.get(name),
      relativeX: position.x,
      relativeY: position.y,
    }))
    .sort((left, right) => left.relativeY - right.relativeY || left.relativeX - right.relativeX);
}

function buildSyncEdgeScores(parsedDocuments) {
  const occupiedByName = new Map(parsedDocuments.map((file) => [file.name, collectOccupiedSyncBlocks(file.decoded.rootIndex)]));
  const scores = new Map();

  for (const source of parsedDocuments) {
    const links = [];

    for (const target of parsedDocuments) {
      if (source.name === target.name) {
        continue;
      }

      const sourceBlocks = occupiedByName.get(source.name);
      const targetBlocks = occupiedByName.get(target.name);

      for (const direction of ["north", "south", "west", "east"]) {
        links.push({
          target: target.name,
          direction,
          score: scoreSyncEdgeDirection(sourceBlocks, targetBlocks, direction),
        });
      }
    }

    scores.set(source.name, links.filter((item) => item.score > 0).sort((left, right) => right.score - left.score));
  }

  return scores;
}

function collectOccupiedSyncBlocks(rootIndex) {
  const occupied = {
    north: new Set(),
    south: new Set(),
    west: new Set(),
    east: new Set(),
  };

  for (let index = 0; index < rootIndex.length; index += 1) {
    if (rootIndex[index] === 0) {
      continue;
    }

    const x = index % SYNC_ROOT_GRID_SIZE;
    const y = Math.floor(index / SYNC_ROOT_GRID_SIZE);

    if (y === 0) {
      occupied.north.add(x);
    }
    if (y === SYNC_ROOT_GRID_SIZE - 1) {
      occupied.south.add(x);
    }
    if (x === 0) {
      occupied.west.add(y);
    }
    if (x === SYNC_ROOT_GRID_SIZE - 1) {
      occupied.east.add(y);
    }
  }

  return occupied;
}

function scoreSyncEdgeDirection(sourceBlocks, targetBlocks, direction) {
  const sourceSet = sourceBlocks[direction];
  const targetSet = targetBlocks[oppositeDirection(direction)];
  let score = 0;

  for (const value of sourceSet) {
    if (targetSet.has(value)) {
      score += 1;
    }
  }

  return score;
}

function oppositeDirection(direction) {
  return (
    {
      north: "south",
      south: "north",
      west: "east",
      east: "west",
    }[direction] ?? "north"
  );
}

function shiftPoint(point, direction) {
  if (direction === "north") {
    return { x: point.x, y: point.y - 1 };
  }
  if (direction === "south") {
    return { x: point.x, y: point.y + 1 };
  }
  if (direction === "west") {
    return { x: point.x - 1, y: point.y };
  }
  return { x: point.x + 1, y: point.y };
}

function scoreSyncPlacement(name, candidate, placed, edgeScores) {
  const key = `${candidate.x},${candidate.y}`;
  if ([...placed.values()].some((position) => `${position.x},${position.y}` === key)) {
    return -Infinity;
  }

  let score = 0;
  const links = edgeScores.get(name) ?? [];

  for (const link of links) {
    const targetPosition = placed.get(link.target);
    if (!targetPosition) {
      continue;
    }

    const expected = shiftPoint(candidate, link.direction);
    if (expected.x === targetPosition.x && expected.y === targetPosition.y) {
      score += link.score * 4;
    } else if (Math.abs(expected.x - targetPosition.x) + Math.abs(expected.y - targetPosition.y) === 1) {
      score += link.score;
    }
  }

  score -= Math.abs(candidate.x) + Math.abs(candidate.y) * 0.75;
  return score;
}

function normalizeRelativeLayout(placed) {
  const points = [...placed.values()];
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const normalized = new Map();

  for (const [name, point] of placed.entries()) {
    normalized.set(name, {
      x: point.x - minX,
      y: point.y - minY,
    });
  }

  return normalized;
}

function assignSyncDocumentsToGrid(relativeLayout, anchor) {
  return relativeLayout.map((file) => ({
    ...file,
    documentX: anchor.documentX + file.relativeX,
    documentY: anchor.documentY + file.relativeY,
  }));
}

function renderSyncDocumentMask(decodedDocument) {
  const width = SYNC_DOCUMENT_CANVAS_SIZE;
  const height = SYNC_DOCUMENT_CANVAS_SIZE;
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceCtx = sourceCanvas.getContext("2d");

  if (!sourceCtx) {
    throw new Error("無法建立中繼畫布。");
  }

  const imageData = sourceCtx.createImageData(width, height);
  const pixelData = imageData.data;
  const fullSourceSize = SYNC_ROOT_GRID_SIZE * SYNC_BLOCK_SIZE_BITS;

  for (let blockIndex = 0; blockIndex < decodedDocument.rootIndex.length; blockIndex += 1) {
    const reference = decodedDocument.rootIndex[blockIndex];
    if (reference === 0) {
      continue;
    }

    const pageIndex = SYNC_ROOT_PAGE_COUNT + (reference - 1) * SYNC_LEAF_PAGES_PER_BLOCK;
    const topPage = readSyncPage(decodedDocument.pageBytes, pageIndex);
    const bottomPage = readSyncPage(decodedDocument.pageBytes, pageIndex + 1);
    const blockX = blockIndex % SYNC_ROOT_GRID_SIZE;
    const blockY = Math.floor(blockIndex / SYNC_ROOT_GRID_SIZE);

    for (const [pageBytes, rowOffset] of [
      [topPage, 0],
      [bottomPage, SYNC_HALF_BLOCK_ROWS],
    ]) {
      if (!pageBytes) {
        continue;
      }

      for (let row = 0; row < SYNC_HALF_BLOCK_ROWS; row += 1) {
        const rowByteOffset = row * 8;

        for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
          const value = pageBytes[rowByteOffset + byteIndex];
          if (value === 0) {
            continue;
          }

          for (let bit = 0; bit < 8; bit += 1) {
            if ((value & (0x80 >> bit)) === 0) {
              continue;
            }

            const cellX = blockX * SYNC_BLOCK_SIZE_BITS + byteIndex * 8 + bit;
            const cellY = blockY * SYNC_BLOCK_SIZE_BITS + rowOffset + row;
            const targetX = Math.min(width - 1, Math.floor((cellX / fullSourceSize) * width));
            const targetY = Math.min(height - 1, Math.floor((cellY / fullSourceSize) * height));
            const pixelIndex = (targetY * width + targetX) * 4;

            pixelData[pixelIndex] = 255;
            pixelData[pixelIndex + 1] = 255;
            pixelData[pixelIndex + 2] = 255;
            pixelData[pixelIndex + 3] = 255;
          }
        }
      }
    }
  }

  sourceCtx.putImageData(imageData, 0, 0);

  return {
    canvas: sourceCanvas,
    width,
    height,
  };
}

function readSyncPage(bytes, pageIndex) {
  const offset = pageIndex * SYNC_PAGE_SIZE_BYTES;
  const end = offset + SYNC_PAGE_SIZE_BYTES;
  if (end > bytes.length) {
    return null;
  }

  return bytes.subarray(offset, end);
}

function latLngToFogGrid(lat, lng) {
  const mapPoint = latLngToFogMapPoint(lat, lng);
  return fogMapPointToDocumentGrid(mapPoint.x, mapPoint.y);
}

function latLngToFogMapPoint(lat, lng) {
  const scale = 256 * 2 ** FOG_WORLD_PIXEL_ZOOM;
  const x = ((lng + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const mercatorY =
    0.5 -
    Math.log((1 + Math.min(Math.max(sinLat, -0.9999), 0.9999)) / (1 - Math.min(Math.max(sinLat, -0.9999), 0.9999))) /
      (4 * Math.PI);

  return {
    x,
    y: mercatorY * scale,
  };
}

function fogMapPointToDocumentGrid(mapPointX, mapPointY) {
  // Mirror the native ConvertMapPointToDocument flow:
  // world pixel @ z20 -> divide by 64 -> document(8192 cells) -> block(64 cells).
  const cellX = Math.trunc(mapPointX * (1 / FOG_CELL_DIVISOR));
  const cellY = Math.trunc(mapPointY * (1 / FOG_CELL_DIVISOR));
  const documentX = Math.floor(cellX / FOG_DOCUMENT_SIZE_CELLS);
  const documentY = Math.floor(cellY / FOG_DOCUMENT_SIZE_CELLS);
  const localCellX = mod(cellX, FOG_DOCUMENT_SIZE_CELLS);
  const localCellY = mod(cellY, FOG_DOCUMENT_SIZE_CELLS);
  const blockX = Math.floor(localCellX / FOG_BLOCK_SIZE_CELLS);
  const blockY = Math.floor(localCellY / FOG_BLOCK_SIZE_CELLS);

  return {
    mapPointX,
    mapPointY,
    cellX,
    cellY,
    documentX,
    documentY,
    documentId: documentX + documentY * FOG_DOCUMENTS_PER_ROW,
    localCellX,
    localCellY,
    blockX,
    blockY,
    blockId: blockX + blockY * FOG_BLOCKS_PER_DOCUMENT,
  };
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function drawSyncDocumentToWorldMask(worldCtx, packedBitmap, bounds) {
  const x = ((bounds.west + 180) / 360) * WORLD_MASK_WIDTH;
  const y = ((WORLD_MASK_NORTH - bounds.north) / (WORLD_MASK_NORTH - WORLD_MASK_SOUTH)) * WORLD_MASK_HEIGHT;
  const width = ((bounds.east - bounds.west) / 360) * WORLD_MASK_WIDTH;
  const height = ((bounds.north - bounds.south) / (WORLD_MASK_NORTH - WORLD_MASK_SOUTH)) * WORLD_MASK_HEIGHT;

  worldCtx.save();
  worldCtx.imageSmoothingEnabled = false;
  worldCtx.drawImage(packedBitmap.canvas, x, y, width, height);
  worldCtx.restore();
}

function fogDocumentToBounds(documentX, documentY) {
  const startCellX = documentX * FOG_DOCUMENT_SIZE_CELLS;
  const startCellY = documentY * FOG_DOCUMENT_SIZE_CELLS;
  const endCellX = startCellX + FOG_DOCUMENT_SIZE_CELLS;
  const endCellY = startCellY + FOG_DOCUMENT_SIZE_CELLS;
  const northWest = fogCellToLatLng(startCellX, startCellY);
  const southEast = fogCellToLatLng(endCellX, endCellY);

  return {
    west: northWest.lng,
    east: southEast.lng,
    north: northWest.lat,
    south: southEast.lat,
  };
}

function fogCellToLatLng(cellX, cellY) {
  const scale = 256 * 2 ** FOG_WORLD_PIXEL_ZOOM;
  const mapPointX = cellX * FOG_CELL_DIVISOR;
  const mapPointY = cellY * FOG_CELL_DIVISOR;
  const lng = (mapPointX / scale) * 360 - 180;
  const mercatorY = mapPointY / scale;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180) / Math.PI;

  return { lat, lng };
}

function extendBounds(bounds, next) {
  if (!bounds) {
    return { ...next };
  }

  return {
    west: Math.min(bounds.west, next.west),
    east: Math.max(bounds.east, next.east),
    north: Math.max(bounds.north, next.north),
    south: Math.min(bounds.south, next.south),
  };
}

function parseGpx(text) {
  const xml = parseXml(text);
  const trackNodes = Array.from(xml.querySelectorAll("trk"));
  const routes = [];

  trackNodes.forEach((trackNode, index) => {
    const segments = Array.from(trackNode.querySelectorAll("trkseg"));
    segments.forEach((segmentNode, segmentIndex) => {
      const points = Array.from(segmentNode.querySelectorAll("trkpt"))
        .map((node) => [Number(node.getAttribute("lat")), Number(node.getAttribute("lon"))])
        .filter(isValidPoint);

      splitImportedPoints(points).forEach((segmentPoints, splitIndex) => {
        routes.push(createImportedRoute(`gpx-${index}-${segmentIndex}-${splitIndex}`, segmentPoints));
      });
    });
  });

  if (routes.length > 0) {
    return routes;
  }

  const routeNodes = Array.from(xml.querySelectorAll("rte"));
  routeNodes.forEach((routeNode, index) => {
    const points = Array.from(routeNode.querySelectorAll("rtept"))
      .map((node) => [Number(node.getAttribute("lat")), Number(node.getAttribute("lon"))])
      .filter(isValidPoint);

    splitImportedPoints(points).forEach((segmentPoints, splitIndex) => {
      routes.push(createImportedRoute(`gpx-rte-${index}-${splitIndex}`, segmentPoints));
    });
  });

  return routes;
}

function parseKml(text) {
  const xml = parseXml(text);
  const routes = [];
  const lineStrings = Array.from(xml.querySelectorAll("LineString"));

  lineStrings.forEach((lineStringNode, index) => {
    const coordinatesNode = lineStringNode.querySelector("coordinates");
    const coordinatesText = coordinatesNode?.textContent ?? "";
    const points = coordinatesText
      .trim()
      .split(/\s+/)
      .map((item) => item.split(",").map(Number))
      .map(([lng, lat]) => [lat, lng])
      .filter(isValidPoint);

    splitImportedPoints(points).forEach((segmentPoints, splitIndex) => {
      routes.push(createImportedRoute(`kml-${index}-${splitIndex}`, segmentPoints));
    });
  });

  return routes;
}

function parseXml(text) {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) {
    throw new Error("檔案格式無法解析。");
  }
  return xml;
}

function splitImportedPoints(points) {
  const segments = [];
  let currentSegment = [];

  for (const point of points) {
    if (currentSegment.length === 0) {
      currentSegment.push(point);
      continue;
    }

    const previousPoint = currentSegment.at(-1);
    const distance = distanceMeters(previousPoint, point);

    if (distance < 1) {
      continue;
    }

    if (distance > MAX_IMPORT_SEGMENT_METERS) {
      if (currentSegment.length >= 2) {
        segments.push(currentSegment);
      }
      currentSegment = [point];
      continue;
    }

    currentSegment.push(point);
  }

  if (currentSegment.length >= 2) {
    segments.push(currentSegment);
  }

  return segments;
}

function createImportedRoute(seed, points) {
  return {
    id: `${seed}-${crypto.randomUUID()}`,
    source: "import",
    color: "#8ecae6",
    points,
  };
}

function distanceMeters([lat1, lng1], [lat2, lng2]) {
  return map.distance([lat1, lng1], [lat2, lng2]);
}

function isValidPoint([lat, lng]) {
  return Number.isFinite(lat) && Number.isFinite(lng);
}

function loadState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { routes: [] };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.routes)) {
      return { routes: [] };
    }

    return {
      routes: parsed.routes
        .filter((route) => route && Array.isArray(route.points))
        .map((route) => ({
          id: route.id ?? crypto.randomUUID(),
          source: route.source ?? "import",
          color: route.color ?? "#f4c95d",
          points: route.points.filter(isValidPoint),
        }))
        .filter((route) => route.points.length > 0),
    };
  } catch {
    return { routes: [] };
  }
}

function persistState() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

window.fogDebug = {
  latLngToFogGrid,
  latLngToFogMapPoint,
  fogMapPointToDocumentGrid,
  fogDocumentToBounds,
  decodeSyncPageTree,
  inferRelativeSyncLayout,
  buildSyncEdgeScores,
  constants: {
    FOG_WORLD_PIXEL_ZOOM,
    FOG_CELL_DIVISOR,
    FOG_DOCUMENT_SIZE_CELLS,
    FOG_BLOCK_SIZE_CELLS,
    FOG_BLOCKS_PER_DOCUMENT,
    FOG_DOCUMENTS_PER_ROW,
    SYNC_PAGE_SIZE_BYTES,
    SYNC_ROOT_PAGE_COUNT,
    SYNC_ROOT_GRID_SIZE,
    SYNC_BLOCK_SIZE_BITS,
    SYNC_MIN_DOCUMENTS,
    TAIWAN_SYNC_ANCHOR,
  },
};
