$ErrorActionPreference = "Stop"

$VAULT = "E:\Obsidian\Plugin開発用"   # ←ここだけ書き換え

npm run build
$DEST  = Join-Path -Path $VAULT -ChildPath ".obsidian\plugins\asciidoc-editor"

if ([string]::IsNullOrWhiteSpace($DEST)) { throw "DEST is empty" }
if (-not (Test-Path -LiteralPath $VAULT)) { throw "Vault path not found: $VAULT" }

New-Item -ItemType Directory -Force -Path $DEST | Out-Null

Copy-Item -Force -LiteralPath ".\manifest.json" -Destination $DEST
Copy-Item -Force -LiteralPath ".\main.js"      -Destination $DEST
if (Test-Path -LiteralPath ".\styles.css") { Copy-Item -Force -LiteralPath ".\styles.css" -Destination $DEST }

Get-ChildItem -LiteralPath $DEST
Write-Host "Deployed to: $DEST"
