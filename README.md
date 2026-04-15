# Fog of World Web Prototype

這是一個最小可用的靜態頁面，先以 `Leaflet` 載入 `OpenStreetMap` 當作地圖基底。

## 在 Debian 12 啟動

確認系統有安裝 `python3` 後，在專案目錄執行：

```bash
python3 -m http.server 8000
```

然後在瀏覽器開啟：

```text
http://localhost:8000
```

## 目前內容

- 顯示 OpenStreetMap 底圖
- 預設視角放在台北 101 附近
- 可用瀏覽器定位切到目前位置

## 下一步建議

- 加入「迷霧遮罩」圖層
- 匯入 GPX 或定位軌跡
- 依已走過區域動態揭露地圖
