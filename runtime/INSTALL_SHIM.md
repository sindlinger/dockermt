# Instalar o shim do `dockermt`

Linux/macOS:

```bash
mkdir -p ~/.local/bin
docker exec dockermt dockermt shim-print bash > ~/.local/bin/dockermt
chmod +x ~/.local/bin/dockermt
export PATH="$HOME/.local/bin:$PATH"
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\bin" | Out-Null
docker exec dockermt dockermt shim-print powershell | Out-File -Encoding ascii "$HOME\bin\dockermt.ps1"
```

- Use somente `dockermt` como comando principal.
