const defaultView = {
  lat: 25.033964,
  lng: 121.564468,
  zoom: 13,
};

const FOG_STORAGE_KEY = "fog-of-world-discoveries";
const DEFAULT_REVEAL_RADIUS_METERS = 900;
const GEOLOCATION_REVEAL_RADIUS_METERS = 700;
const CLICK_REVEAL_RADIUS_METERS = 500;

const statusEl = document.querySelector("#status");
const locateBtn = document.querySelector("#locateBtn");

const map = L.map("map", {
  zoomControl: true,
}).setView([defaultView.lat, defaultView.lng], defaultView.zoom);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const FogLayer = L.Layer.extend({
  initialize(discoveries = []) {
    this.discoveries = discoveries;
  },

  onAdd(activeMap) {
    this._map = activeMap;
    this._canvas = L.DomUtil.create("canvas", "leaflet-fog-layer");
    this._canvas.style.pointerEvents = "none";
    this._ctx = this._canvas.getContext("2d");

    const pane = activeMap.getPanes().overlayPane;
    pane.appendChild(this._canvas);

    activeMap.on("move zoom resize", this._reset, this);
    this._reset();
  },

  onRemove(activeMap) {
    activeMap.off("move zoom resize", this._reset, this);
    L.DomUtil.remove(this._canvas);
  },

  setDiscoveries(discoveries) {
    this.discoveries = discoveries;
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

    ctx.fillStyle = "rgba(6, 10, 8, 0.88)";
    ctx.fillRect(0, 0, width, height);

    ctx.globalCompositeOperation = "destination-out";

    this.discoveries.forEach((discovery) => {
      const center = L.latLng(discovery.lat, discovery.lng);
      const point = this._map.latLngToContainerPoint(center);
      const radius = this._metersToPixels(center, discovery.radius);
      const glowRadius = radius * 1.55;

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
    });

    ctx.globalCompositeOperation = "source-over";
  },

  _metersToPixels(center, meters) {
    const bounds = center.toBounds(meters * 2);
    const northEastPoint = this._map.latLngToContainerPoint(bounds.getNorthEast());
    const centerPoint = this._map.latLngToContainerPoint(center);
    return Math.max(Math.abs(northEastPoint.x - centerPoint.x), 40);
  },
});

const discoveries = loadDiscoveries();

if (discoveries.length === 0) {
  discoveries.push({
    lat: defaultView.lat,
    lng: defaultView.lng,
    radius: DEFAULT_REVEAL_RADIUS_METERS,
  });
  persistDiscoveries();
}

const fogLayer = new FogLayer(discoveries);
fogLayer.addTo(map);

let marker;

statusEl.textContent = "迷霧已啟用。可按定位，或直接點地圖揭露區域。";

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    statusEl.textContent = "你的瀏覽器不支援定位。";
    return;
  }

  statusEl.textContent = "正在取得目前位置...";

  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      const { latitude, longitude } = coords;

      map.setView([latitude, longitude], 16);
      updateMarker(latitude, longitude, "你的目前位置");
      revealArea(latitude, longitude, GEOLOCATION_REVEAL_RADIUS_METERS);

      statusEl.textContent = `已揭露你附近的區域。座標 ${latitude.toFixed(5)}, ${longitude.toFixed(5)}。`;
    },
    (error) => {
      const message =
        error.code === error.PERMISSION_DENIED
          ? "定位權限被拒絕。"
          : "無法取得位置。";
      statusEl.textContent = message;
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
    },
  );
});

map.on("click", (event) => {
  const { lat, lng } = event.latlng;
  revealArea(lat, lng, CLICK_REVEAL_RADIUS_METERS);
  statusEl.textContent = `已揭露點擊位置附近區域。座標 ${lat.toFixed(5)}, ${lng.toFixed(5)}。`;
});

function updateMarker(lat, lng, label) {
  if (!marker) {
    marker = L.marker([lat, lng]).addTo(map);
  } else {
    marker.setLatLng([lat, lng]);
  }

  marker.bindPopup(label).openPopup();
}

function revealArea(lat, lng, radius) {
  discoveries.push({ lat, lng, radius });
  persistDiscoveries();
  fogLayer.setDiscoveries(discoveries);
}

function loadDiscoveries() {
  try {
    const raw = window.localStorage.getItem(FOG_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isValidDiscovery);
  } catch {
    return [];
  }
}

function persistDiscoveries() {
  window.localStorage.setItem(FOG_STORAGE_KEY, JSON.stringify(discoveries));
}

function isValidDiscovery(discovery) {
  return (
    typeof discovery === "object" &&
    discovery !== null &&
    Number.isFinite(discovery.lat) &&
    Number.isFinite(discovery.lng) &&
    Number.isFinite(discovery.radius)
  );
}
