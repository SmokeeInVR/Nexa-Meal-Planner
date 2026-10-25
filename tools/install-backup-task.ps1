# Registers the weekly Meal Planner backup as a Windows scheduled task for the current user
# (Sundays 4:00 AM; runs late if the PC was off). Re-running replaces the task.
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
$script = Join-Path $PSScriptRoot 'backup-meals.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "--no-warnings `"$script`"" -WorkingDirectory (Split-Path $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 4am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'NEXA Meal Planner Weekly Backup' -Action $action -Trigger $trigger -Settings $settings -Description 'Downloads and verifies a backup of the household Meal Planner data into NEXA-Data\meal-backups.' -Force | Out-Null
Write-Output 'Registered: NEXA Meal Planner Weekly Backup (Sundays 4:00 AM)'
