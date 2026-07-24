using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal static class WindowsBatchLogon
{
    private const int Logon32LogonBatch = 4;
    private const int Logon32ProviderDefault = 0;

    internal static SafeAccessTokenHandle Logon(string accountName, string password)
    {
        var passwordPointer = Marshal.StringToCoTaskMemUni(password);
        try
        {
            if (LogonUser(
                    accountName,
                    ".",
                    passwordPointer,
                    Logon32LogonBatch,
                    Logon32ProviderDefault,
                    out var token))
            {
                return token;
            }
            var error = Marshal.GetLastWin32Error();
            throw new NativeExecutionException(
                error is 1326 or 1330 or 1385 ? "credential_failure" : "process_start_failure",
                "LOGON32_LOGON_BATCH failed",
                innerException: new Win32Exception(error));
        }
        finally
        {
            Marshal.ZeroFreeCoTaskMemUnicode(passwordPointer);
        }
    }

    [DllImport("Advapi32.dll", EntryPoint = "LogonUserW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool LogonUser(
        string userName,
        string domain,
        IntPtr password,
        int logonType,
        int logonProvider,
        out SafeAccessTokenHandle token);
}
