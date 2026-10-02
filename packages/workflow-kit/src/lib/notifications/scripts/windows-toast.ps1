param(
    [string]$Title = "Pi",
    [string]$Message = "Task completed."
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$appId = Get-StartApps |
    Where-Object {
        $_.AppID -like "*WindowsTerminal*" -or
        $_.AppID -like "*Terminal*"
    } |
    Select-Object -First 1 -ExpandProperty AppID
if ([string]::IsNullOrWhiteSpace($appId)) {
    throw "Registered Windows Terminal AppUserModelID not found"
}

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02
)
$toastElement = $xml.GetElementsByTagName("toast").Item(0)
$text = $xml.GetElementsByTagName("text")
[void]$text.Item(0).AppendChild($xml.CreateTextNode($Title))
[void]$text.Item(1).AppendChild($xml.CreateTextNode($Message))

$actions = $xml.CreateElement("actions")
$action = $xml.CreateElement("action")
[void]$action.SetAttribute("content", "Dismiss")
[void]$action.SetAttribute("arguments", "dismiss")
[void]$action.SetAttribute("activationType", "system")
[void]$actions.AppendChild($action)
[void]$toastElement.AppendChild($actions)

$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(1)
$toast.Tag = "pi-notification"
$toast.Group = "Pi"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
