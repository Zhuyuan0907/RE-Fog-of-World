# Fog of World Web Prototype

這是一個以 `Leaflet + OpenStreetMap` 為基底的 Fog of World 網頁原型。

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

- 全畫面 OpenStreetMap
- 以「沿路徑揭露」為核心的迷霧遮罩
- 可使用瀏覽器定位與即時追蹤
- 支援匯入 `GPX` / `KML`
- 匯入時會忽略連續兩點距離超過 `10km` 的段落
- 已揭露路徑會保存在瀏覽器 `localStorage`

## 下一步建議

- 研究 Android `Sync` 備份格式，將既有探索遮罩直接套用到網頁版
- 將迷霧改成多層狀態，例如未探索 / 已探索 / 近期軌跡
- 加入匯出與分享功能
