using System.Collections;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class RestrictedEnvironment : IDisposable
{
    private const uint TokenQuery = 0x0008;

    private static readonly HashSet<string> AllowedVariables = new(StringComparer.OrdinalIgnoreCase)
    {
        "PATH",
        "PATHEXT",
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMDATA",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "TERM",
        "LANG",
        "LC_ALL",
        "PWD",
    };

    private static readonly HashSet<string> ProtectedVariables = new(StringComparer.OrdinalIgnoreCase)
    {
        "SYSTEMROOT",
        "WINDIR",
        "COMSPEC",
        "TEMP",
        "TMP",
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "APPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMDATA",
        "PWD",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
    };

    private IntPtr block;

    private RestrictedEnvironment(Dictionary<string, string> variables, IntPtr block)
    {
        Variables = variables;
        this.block = block;
    }

    internal IReadOnlyDictionary<string, string> Variables { get; }
    internal IntPtr Block => block;

    internal static bool IsCallerVariableAllowed(string name) => AllowedVariables.Contains(name);

    internal static RestrictedEnvironment Create(
        IReadOnlyDictionary<string, string> requested,
        string mode,
        string networkMode,
        WindowsRuntimeDirectory runtimeDirectory,
        string cwd)
    {
        var accountEnvironment = LoadCurrentAccountEnvironment();
        var variables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in accountEnvironment)
        {
            if (AllowedVariables.Contains(name)) variables[name.ToUpperInvariant()] = value;
        }
        foreach (var (name, value) in requested)
        {
            var normalizedName = name.ToUpperInvariant();
            if (!AllowedVariables.Contains(normalizedName))
            {
                throw new RequestException($"environment variable is not allowed: {name}");
            }
            variables[normalizedName] = value;
        }
        foreach (var name in ProtectedVariables)
        {
            if (accountEnvironment.TryGetValue(name, out var value)) variables[name] = value;
            else variables.Remove(name);
        }
        var systemRoot = RequireVariable(variables, "SYSTEMROOT");
        variables["WINDIR"] = systemRoot;
        variables["COMSPEC"] = Path.Combine(systemRoot, "System32", "cmd.exe");
        variables["TEMP"] = runtimeDirectory.Path;
        variables["TMP"] = runtimeDirectory.Path;
        variables["HOME"] = runtimeDirectory.Path;
        variables["APPDATA"] = runtimeDirectory.RoamingAppData;
        variables["LOCALAPPDATA"] = runtimeDirectory.LocalAppData;
        variables["PWD"] = cwd;
        variables["GIT_CONFIG_NOSYSTEM"] = "1";
        variables["GIT_CONFIG_GLOBAL"] = "NUL";
        variables["GIT_TERMINAL_PROMPT"] = "0";
        variables["ARIADNE_RESTRICTED_PROCESS"] = "1";
        variables["ARIADNE_SANDBOX_MODE"] = mode;
        variables["ARIADNE_NETWORK_MODE"] = networkMode;

        var serialized = string.Join(
            '\0',
            variables.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase)
                .Select(pair => $"{pair.Key}={pair.Value}")) + "\0";
        return new RestrictedEnvironment(variables, Marshal.StringToHGlobalUni(serialized));
    }

    public void Dispose()
    {
        if (block == IntPtr.Zero) return;
        Marshal.FreeHGlobal(block);
        block = IntPtr.Zero;
    }

    private static Dictionary<string, string> LoadCurrentAccountEnvironment()
    {
        if (!OpenProcessToken(Process.GetCurrentProcess().SafeHandle, TokenQuery, out var token))
        {
            throw Failure("OpenProcessToken for environment failed");
        }
        using (token)
        {
            if (!CreateEnvironmentBlock(out var environment, token, false))
            {
                throw Failure("CreateEnvironmentBlock failed");
            }
            try
            {
                return ParseEnvironmentBlock(environment);
            }
            finally
            {
                _ = DestroyEnvironmentBlock(environment);
            }
        }
    }

    private static Dictionary<string, string> ParseEnvironmentBlock(IntPtr environment)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var cursor = environment;
        while (true)
        {
            var entry = Marshal.PtrToStringUni(cursor) ?? string.Empty;
            if (entry.Length == 0) return result;
            cursor = IntPtr.Add(cursor, checked((entry.Length + 1) * sizeof(char)));
            var separator = entry.IndexOf('=', 1);
            if (separator <= 0) continue;
            result[entry[..separator]] = entry[(separator + 1)..];
        }
    }

    private static string RequireVariable(IReadOnlyDictionary<string, string> variables, string name)
    {
        if (variables.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value)) return value;
        throw new NativeExecutionException("process_start_failure", $"sandbox account environment is missing {name}");
    }

    private static NativeExecutionException Failure(string message) => new(
        "process_start_failure",
        message,
        innerException: new Win32Exception(Marshal.GetLastWin32Error()));

    [DllImport("Advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(
        SafeProcessHandle process,
        uint desiredAccess,
        out SafeAccessTokenHandle token);

    [DllImport("Userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateEnvironmentBlock(
        out IntPtr environment,
        SafeAccessTokenHandle token,
        [MarshalAs(UnmanagedType.Bool)] bool inherit);

    [DllImport("Userenv.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyEnvironmentBlock(IntPtr environment);
}
