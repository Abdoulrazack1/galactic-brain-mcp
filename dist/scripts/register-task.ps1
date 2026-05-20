# Galactic Brain — Enregistre la tâche planifiée Windows pour auto-push 30 min
# À LANCER UNE SEULE FOIS, en utilisateur normal (pas admin nécessaire)
#
# Pour vérifier ensuite : Get-ScheduledTask -TaskName 'GalacticBrain-AutoPush'
# Pour désinstaller    : Unregister-ScheduledTask -TaskName 'GalacticBrain-AutoPush' -Confirm:$false

$TaskName  = "GalacticBrain-AutoPush"
$ScriptPath = "C:\Users\PC\galactic-brain-mcp\dist\scripts\auto-push.ps1"

if (-not (Test-Path $ScriptPath)) {
  Write-Host "❌ Script introuvable : $ScriptPath" -ForegroundColor Red
  exit 1
}

# Désinstalle l'ancienne tâche si elle existe (re-register safe)
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Tâche existante détectée, désinstallation..." -ForegroundColor Yellow
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# Action : lance auto-push.ps1 via powershell -NoProfile (rapide)
$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

# Trigger : toutes les 30 min, indéfiniment, dès maintenant
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
  -RepetitionInterval (New-TimeSpan -Minutes 30) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

# Settings : ne pas démarrer sur batterie, ne pas réveiller le PC, exit si déjà running
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
  -MultipleInstances IgnoreNew

# Principal : tourne sous l'user actuel, niveau Limited (suffisant)
$Principal = New-ScheduledTaskPrincipal `
  -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive `
  -RunLevel Limited

# Register
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal `
  -Description "Galactic Brain - auto-push du vault Obsidian toutes les 30 min vers GitHub"

Write-Host ""
Write-Host "✅ Tâche enregistrée : $TaskName" -ForegroundColor Green
Write-Host "   Démarre dans 2 min, puis répète toutes les 30 min"
Write-Host "   Log : $env:LOCALAPPDATA\GalacticBrain\auto-push.log"
Write-Host ""
Write-Host "Commandes utiles :"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName'             # statut"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'           # forcer un push immédiat"
Write-Host "  Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false  # désinstaller"
