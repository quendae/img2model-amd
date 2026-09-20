!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Preparing Img2Model AMD native Radeon runtime..."
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer-payload\scripts\setup\install-img2model-runtime.ps1" -PayloadRoot "$INSTDIR\resources\installer-payload"' $0

  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Img2Model AMD was installed, but the Radeon runtime setup failed. Check %LOCALAPPDATA%\Img2ModelAMD\logs\installer-runtime.log, fix the reported prerequisite, and rerun setup."
    Abort
  ${EndIf}
!macroend
