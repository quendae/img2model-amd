#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif

#define MyAppName "Img2Model AMD"
#define MyAppExeName "img2model-amd.exe"
#define MyAppPublisher "quendae"
#define MyAppId "{{2645C00D-DE89-548B-940D-9908BBE8A3B2}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Img2Model AMD
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=output
OutputBaseFilename=Img2Model AMD_{#MyAppVersion}_x64-setup
SetupIconFile=..\icons\icon.ico
UninstallDisplayIcon={app}\img2model-amd.exe
UninstallDisplayName={#MyAppName}
WizardStyle=modern
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=yes
DisableDirPage=auto
AllowNoIcons=yes
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "polish"; MessagesFile: "compiler:Languages\Polish.isl"

[CustomMessages]
english.PreparingRuntime=Preparing native Radeon runtime. This can take a while on first install...
polish.PreparingRuntime=Przygotowywanie natywnego środowiska Radeon. Przy pierwszej instalacji może to potrwać...
english.RuntimeFailed=The Img2Model AMD Radeon runtime setup failed. Check %LOCALAPPDATA%\Img2ModelAMD\logs\installer-runtime.log and rerun the installer.
polish.RuntimeFailed=Konfiguracja środowiska Radeon dla Img2Model AMD nie powiodła się. Sprawdź %LOCALAPPDATA%\Img2ModelAMD\logs\installer-runtime.log i uruchom instalator ponownie.
english.MigrationFailed=The previous Img2Model AMD installation could not be removed. Close Img2Model AMD and rerun the installer.
polish.MigrationFailed=Nie udało się usunąć poprzedniej instalacji Img2Model AMD. Zamknij program i uruchom instalator ponownie.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\target\release\img2model-amd.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\resources\installer-payload\*"; DestDir: "{app}\resources\installer-payload"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
const
  OldNsisUninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Img2Model AMD';

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  OldUninstaller: String;
  ResultCode: Integer;
begin
  Result := '';
  OldUninstaller := ExpandConstant('{localappdata}\Img2Model AMD\uninstall.exe');

  if FileExists(OldUninstaller) then
  begin
    Log('Migrating previous Tauri/NSIS installation before Inno Setup install.');
    if (not Exec(OldUninstaller, '/S', '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
       (ResultCode <> 0) then
    begin
      Result := ExpandConstant('{cm:MigrationFailed}');
      exit;
    end;
  end;

  { Remove the stale NSIS Add/Remove Programs registration if it remains. }
  RegDeleteKeyIncludingSubkeys(HKCU, OldNsisUninstallKey);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PowerShellExe: String;
  RuntimeScript: String;
  PayloadRoot: String;
  Params: String;
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    WizardForm.StatusLabel.Caption := ExpandConstant('{cm:PreparingRuntime}');
    PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
    PayloadRoot := ExpandConstant('{app}\resources\installer-payload');
    RuntimeScript := PayloadRoot + '\scripts\setup\install-img2model-runtime.ps1';
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' + RuntimeScript +
      '" -PayloadRoot "' + PayloadRoot + '"';

    Log('Starting Img2Model AMD Radeon runtime bootstrap.');
    if not Exec(PowerShellExe, Params, ExpandConstant('{app}'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode) then
      RaiseException(ExpandConstant('{cm:RuntimeFailed}'));

    if ResultCode <> 0 then
      RaiseException(ExpandConstant('{cm:RuntimeFailed}'));
  end;
end;

{ Persistent runtime/cache lives under {localappdata}\Img2ModelAMD\runtime and is intentionally never deleted by this installer. }
