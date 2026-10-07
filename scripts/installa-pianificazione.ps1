<#
.SYNOPSIS
  Registra nell'Utilità di pianificazione di Windows i comandi giornalieri:
  "npm run rss" (default 07:00), "npm run adatta" (default 07:30) e "npm run invia" (default 08:30).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\installa-pianificazione.ps1
  powershell -ExecutionPolicy Bypass -File scripts\installa-pianificazione.ps1 -OraRss 06:30 -OraAdatta 07:00 -OraInvia 09:00
  powershell -ExecutionPolicy Bypass -File scripts\installa-pianificazione.ps1 -Rimuovi
#>
param(
    [string]$OraRss = "07:00",
    [string]$OraAdatta = "07:30",
    [string]$OraInvia = "08:30",
    [switch]$Rimuovi
)

$ErrorActionPreference = "Stop"

$Cartella = "\Doublegram-LinkedIn\"
$Progetto = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Attivita = @(
    @{ Nome = "doublegram-linkedin-rss";    Comando = "rss";    Ora = $OraRss },
    @{ Nome = "doublegram-linkedin-adatta"; Comando = "adatta"; Ora = $OraAdatta },
    @{ Nome = "doublegram-linkedin-invia";  Comando = "invia";  Ora = $OraInvia }
)

if ($Rimuovi) {
    foreach ($a in $Attivita) {
        Unregister-ScheduledTask -TaskName $a.Nome -TaskPath $Cartella -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "Rimossa: $($a.Nome)"
    }
    exit 0
}

if (-not (Test-Path (Join-Path $Progetto ".env"))) {
    throw "Manca il file .env in $Progetto. Copia .env.example in .env e compilalo prima di pianificare."
}

$Npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $Npm) { throw "npm non trovato nel PATH. Installa Node 22 e riapri PowerShell." }

$Utente = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
# Interactive: gira solo con l'utente collegato, quando Google Drive (G:) è montato.
$Principal = New-ScheduledTaskPrincipal -UserId $Utente -LogonType Interactive -RunLevel Limited
# StartWhenAvailable: se il PC era spento all'orario previsto, parte appena possibile.
$Impostazioni = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1)

foreach ($a in $Attivita) {
    $Ora = [datetime]::ParseExact($a.Ora, "HH:mm", [Globalization.CultureInfo]::InvariantCulture)
    $Azione = New-ScheduledTaskAction `
        -Execute "cmd.exe" `
        -Argument "/c `"`"$Npm`" run $($a.Comando) >> logs\pianificazione.log 2>&1`"" `
        -WorkingDirectory $Progetto
    $Trigger = New-ScheduledTaskTrigger -Daily -At $Ora

    Register-ScheduledTask `
        -TaskName $a.Nome `
        -TaskPath $Cartella `
        -Action $Azione `
        -Trigger $Trigger `
        -Principal $Principal `
        -Settings $Impostazioni `
        -Description "doublegram-linkedin-engine: npm run $($a.Comando)" `
        -Force | Out-Null

    Write-Host ("Registrata: {0} tutti i giorni alle {1}" -f $a.Nome, $Ora.ToString("HH:mm"))
}

New-Item -ItemType Directory -Force -Path (Join-Path $Progetto "logs") | Out-Null
Write-Host ""
Write-Host "Fatto. Le attivita' sono in Utilita' di pianificazione > Libreria > Doublegram-LinkedIn."
Write-Host "Per provarle subito: Start-ScheduledTask -TaskPath '$Cartella' -TaskName doublegram-linkedin-adatta"
