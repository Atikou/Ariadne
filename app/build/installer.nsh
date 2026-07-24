!macro customInit
  ; Upgrade/install never competes with a live UI or native sandbox helper.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "Ariadne.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "Ariadne.WindowsSandbox.exe"'
  Pop $0
!macroend

!macro customUnInit
  ; Ensure uninstall can remove binaries even after an interrupted prior shutdown.
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "Ariadne.exe"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "Ariadne.WindowsSandbox.exe"'
  Pop $0
!macroend

!macro customUnInstall
  ; Silent enterprise uninstall preserves data. Interactive uninstall requires
  ; an explicit destructive choice and defaults to preservation.
  IfSilent preserve_user_data
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
    "Delete Ariadne user data, settings, checkpoints, and database backups?" \
    IDYES delete_user_data IDNO preserve_user_data

  delete_user_data:
    RMDir /r "$APPDATA\Ariadne"

  preserve_user_data:
!macroend
