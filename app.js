const defaultView = {
  lat: 25.033964,
  lng: 121.564468,
  zoom: 13,
};

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

let marker;

statusEl.textContent = "OpenStreetMap 已載入。";

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
      if (!marker) {
        marker = L.marker([latitude, longitude]).addTo(map);
      } else {
        marker.setLatLng([latitude, longitude]);
      }
      marker.bindPopup("你的目前位置").openPopup();

      statusEl.textContent = `已定位到緯度 ${latitude.toFixed(5)}、經度 ${longitude.toFixed(5)}。`;
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
