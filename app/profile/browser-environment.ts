/** Only operating-system settings needed by Chromium may cross into a public browser process. */
const PUBLIC_BROWSER_ENV_KEYS = new Set([
  'APPDATA', 'COMSPEC', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'HOME',
  'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'LOCALAPPDATA', 'PATH',
  'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WAYLAND_DISPLAY',
  'WINDIR', 'XAUTHORITY', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
]);

/** The public browser launch never inherits provider or unrelated host variables. */
export function restrictedBrowserEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (PUBLIC_BROWSER_ENV_KEYS.has(name.toUpperCase()) && typeof value === 'string') {
      environment[name] = value;
    }
  }
  return environment;
}
