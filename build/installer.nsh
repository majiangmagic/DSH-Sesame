; NSIS 定制：卸载/覆盖安装时**保留**版本池与快照。
;
; 背景：electron-builder 的 NSIS 模板在卸载时会 `RMDir /r $INSTDIR`，
; 把安装目录整个删掉 —— 用户 1.1 GB 的版本池就是这么没的。
; 这两个目录现在是数据（版本池 / 快照），不能跟程序本体一起删。
;
; 做法：卸载前把它们**临时改名**到同盘的旁边目录（Rename 同盘是瞬间的，
;       跨盘会失败，所以不用 $TEMP —— 它可能在另一个盘），删完 $INSTDIR 再改回来。
;
; 注意：这只对**已包含本文件**的版本生效。从旧版本升级时，NSIS 会先跑
;       **旧版本自己的卸载器** —— 那个卸载器里没有这段保护，所以那一次仍会被删。

!macro customRemoveFiles
  StrCpy $0 "$INSTDIR\..\_DSH-Sesame-keep"
  CreateDirectory "$0"

  IfFileExists "$INSTDIR\dsh\*.*" 0 +2
    Rename "$INSTDIR\dsh" "$0\dsh"
  IfFileExists "$INSTDIR\snapshots\*.*" 0 +2
    Rename "$INSTDIR\snapshots" "$0\snapshots"

  ; 原模板的行为：删掉安装目录
  RMDir /r "$INSTDIR"

  IfFileExists "$0\dsh\*.*" 0 +2
    Rename "$0\dsh" "$INSTDIR\dsh"
  IfFileExists "$0\snapshots\*.*" 0 +2
    Rename "$0\snapshots" "$INSTDIR\snapshots"
  RMDir "$0"
!macroend
