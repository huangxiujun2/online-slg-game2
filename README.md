# 邊境紀元

使用 Vue 3、Vite 與 WebRTC 製作的即時多人 2.5D 策略遊戲。由房主瀏覽器運行戰局，玩家之間直接傳送遊戲資料，不需要自架常駐遊戲伺服器。

## 開始遊戲

```sh
npm install
npm run dev
```

開啟 Vite 顯示的網址（預設 `http://localhost:5173`）。使用 HTTPS 網址或 localhost 才能使用瀏覽器的 WebRTC 功能。

## 與朋友連線

1. 房主建立新戰局，複製「房主連線代碼」並傳給朋友。
2. 朋友貼上代碼、輸入名字，複製產生的回覆代碼傳回房主。
3. 房主貼上回覆代碼並確認；連線成功後即可開始遊戲。

兩位玩家的瀏覽器透過公開 STUN 服務嘗試建立直接連線；房主必須保持遊戲分頁開啟。部分路由器、防火牆或校園網路會阻擋點對點連線，這種情況下仍需要 TURN 中繼服務。

## 部署到 GitHub Pages

推送到 `main` 分支後，GitHub Actions 會自動建置並部署至：

`https://huangxiujun2.github.io/online-slg-game2/`

GitHub Pages 初次啟用時，請在 repository 的 **Settings → Pages → Build and deployment** 選擇 **GitHub Actions**。

## 操作方式

- 輸入名稱並建立戰局，依照連線步驟與朋友交換代碼。
- 點選自己的村民或劍士，再點擊地圖移動；按 `A` 可選取全部部隊，按 `Esc` 取消選取。
- 村民會生產食物，城鎮會持續生產木材與黃金；訓練劍士並帶往敵方城堡即可發動攻擊。
- 摧毀對方城堡（耐久降至 0）即可獲勝。