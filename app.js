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

const statusEl = document.querySelector("#status");
const locateBtn = document.querySelector("#locateBtn");
const trackBtn = document.querySelector("#trackBtn");
const importBtn = document.querySelector("#importBtn");
const clearBtn = document.querySelector("#clearBtn");
const fileInput = document.querySelector("#fileInput");

const map = L.map("map", {
  zoomControl: true,
}).setView([defaultView.lat, defaultView.lng], defaultView.zoom);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const routeLayer = L.layerGroup().addTo(map);

const FogLayer = L.Layer.extend({
  initialize(reveals = []) {
    this.reveals = reveals;
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

  _metersToPixels(center, meters) {
    const bounds = center.toBounds(meters * 2);
    const northEastPoint = this._map.latLngToContainerPoint(bounds.getNorthEast());
    const centerPoint = this._map.latLngToContainerPoint(center);
    return Math.max(Math.abs(northEastPoint.x - centerPoint.x), 14);
  },
});

const state = loadState();
const fogLayer = new FogLayer([]);

fogLayer.addTo(map);
redrawRoutesAndFog();

let marker;
let watchId = null;
let liveRoute = null;

setStatus("Fog of World 風格迷霧已啟用。可追蹤即時移動，或匯入 GPX/KML。");
updateTrackButton();

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
      appendPointToRoute(ensureLiveRoute(), point, LIVE_REVEAL_RADIUS_METERS);
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

clearBtn.addEventListener("click", () => {
  state.routes = [];
  liveRoute = null;
  persistState();
  redrawRoutesAndFog();
  if (marker) {
    map.removeLayer(marker);
    marker = null;
  }
  setStatus("已清除網頁版紀錄。");
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
      const appended = appendPointToRoute(liveRoute, point, LIVE_REVEAL_RADIUS_METERS);

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

function appendPointToRoute(route, point, revealRadius) {
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
  trackBtn.textContent = watchId === null ? "開始追蹤" : "停止追蹤";
}

function setStatus(message) {
  statusEl.textContent = message;
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
