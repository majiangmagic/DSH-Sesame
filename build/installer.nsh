;
; DSH-Sesame 安装器覆盖：**升级时不要搬空 $INSTDIR**
;
; 背景（实测现场）：NSIS 默认的升级流程（electron-builder 的 uninstaller.nsh:160-188）
; 在 isUpdated 时会先 `atomicRMDir` —— 把 $INSTDIR 里**每一项逐个改名**到
; `%TEMP%\old-install`，再 `RMDir /r $INSTDIR`。
;
; 而这个应用的旧版本把数据（版本池 dsh/、解压出来的桌面端 desktop/）放在安装目录里，
; 于是升级要搬 10 GB 到 %TEMP%（D:→C: 是跨盘复制）。实测那次搬迁把 274,529 个文件
; 全部搬完之后，安装器就没有下文了 —— 应用已关、窗口不再出现、安装器进程挂着不动。
;
; 这里覆盖 `customRemoveFiles`（electron-builder 检测到这个宏就不走默认那套），
; 改成**只删应用自身的文件**：新的安装包会原样覆盖它们，而用户数据目录原地不动，
; 既不跨盘搬 10 GB，也不会被 RMDir /r 顺手删掉。
;
; 注意：这个宏影响的是**卸载/升级**时删文件的那一步。真正执行它的，是**当前已安装版本**
; 里内嵌的卸载器 —— 所以修好的是"装了这个版本之后的所有升级"，救不了从旧版本升上来的
; 那一次（那一次仍要先把数据搬出安装目录）。
;

!macro customRemoveFiles
  ; 这行是**可检索的标记**：打完包后在 Setup.exe 里 grep 它，用来确认这个宏真的被
  ; electron-builder 收进去了（`nsis.include` 写错路径时不会报错，只会静默用默认流程）。
  DetailPrint "DSH-Sesame: keep-user-data-dirs"

  ; 应用自身的文件：删掉，让新版本原样覆盖（不删也能覆盖，删了更干净）
  Delete "$INSTDIR\*.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\*.ico"
  Delete "$INSTDIR\*.yml"

  ; 应用自身的目录
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"

  ; 随包带的 Node 运行时（安装包会重新放一份）
  RMDir /r "$INSTDIR\node"

  ; ⚠️ 刻意**不碰**下面这些 —— 它们是用户数据，可能在旧版本里就落在安装目录中：
  ;     $INSTDIR\dsh\          dsh 版本池（每个版本一套 node_modules）
  ;     $INSTDIR\desktop\      解压出来的官方桌面端（GB 量级）
  ;     $INSTDIR\snapshots\    插件配置快照
  ; 新版默认把数据放在安装目录**隔壁**（见 src/main/platform/paths.ts），
  ; 这里保留判断是为了让"还没迁移的老机器"升级时也不丢东西。
!macroend
