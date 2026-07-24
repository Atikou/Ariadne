using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace Ariadne.WindowsSandbox;

internal static class CredentialVault
{
    private const int CryptProtectUiForbidden = 0x1;
    private const long MaxVaultBytes = 1024 * 1024;
    private const int MaxDpapiPayloadBytes = 1024 * 1024;
    private const int ZeroBufferBytes = 4096;

    internal static void Save(
        DesiredPolicy policy,
        SecurityIdentifier ownerSid,
        string offlinePassword,
        string onlinePassword)
    {
        var entropy = BuildEntropy(policy.StateRoot);
        try
        {
            var record = new CredentialVaultRecord
            {
                OwnerSid = ownerSid.Value,
                OfflineUser = policy.OfflineUser,
                OfflinePassword = Protect(offlinePassword, entropy),
                OnlineUser = policy.OnlineUser,
                OnlinePassword = Protect(onlinePassword, entropy),
            };
            StateStorage.WriteJsonAtomic(policy.StateRoot, StateStorage.VaultFileName, record, ownerSid);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(entropy);
        }
    }

    internal static (string OfflinePassword, string OnlinePassword) Load(
        DesiredPolicy policy,
        SecurityIdentifier ownerSid)
    {
        CredentialVaultRecord record;
        try
        {
            record = StateStorage.ReadJson<CredentialVaultRecord>(
                policy.StateRoot,
                StateStorage.VaultFileName,
                MaxVaultBytes) ?? throw new SetupException("credential_vault_missing");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            throw new SetupException("credential_vault_invalid", error);
        }
        if (record.Version != 1 ||
            !string.Equals(record.OwnerSid, ownerSid.Value, StringComparison.Ordinal) ||
            !string.Equals(record.OfflineUser, policy.OfflineUser, StringComparison.Ordinal) ||
            !string.Equals(record.OnlineUser, policy.OnlineUser, StringComparison.Ordinal))
        {
            throw new SetupException("credential_vault_identity_mismatch");
        }
        var entropy = BuildEntropy(policy.StateRoot);
        try
        {
            return (Unprotect(record.OfflinePassword, entropy), Unprotect(record.OnlinePassword, entropy));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(entropy);
        }
    }

    private static byte[] BuildEntropy(string stateRoot) =>
        SHA256.HashData(Encoding.UTF8.GetBytes($"Ariadne.WindowsSandbox.v1\0{stateRoot}"));

    private static string Protect(string plaintext, byte[] entropy)
    {
        var bytes = Encoding.UTF8.GetBytes(plaintext);
        try
        {
            return Convert.ToBase64String(ProtectOrUnprotect(bytes, entropy, protect: true));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static string Unprotect(string ciphertext, byte[] entropy)
    {
        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(ciphertext);
        }
        catch (FormatException error)
        {
            throw new SetupException("credential_vault_ciphertext_invalid", error);
        }
        var plaintext = ProtectOrUnprotect(bytes, entropy, protect: false);
        try
        {
            return Encoding.UTF8.GetString(plaintext);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
            CryptographicOperations.ZeroMemory(bytes);
        }
    }

    private static byte[] ProtectOrUnprotect(byte[] input, byte[] entropy, bool protect)
    {
        if (input.Length is <= 0 or > MaxDpapiPayloadBytes)
        {
            throw new SetupException("dpapi_input_size_invalid");
        }
        using var inputBlob = DataBlobHandle.Create(input);
        using var entropyBlob = DataBlobHandle.Create(entropy);
        DataBlob output = default;
        var succeeded = protect
            ? CryptProtectData(ref inputBlob.Value, "Ariadne sandbox credential", ref entropyBlob.Value, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, ref output)
            : CryptUnprotectData(ref inputBlob.Value, IntPtr.Zero, ref entropyBlob.Value, IntPtr.Zero, IntPtr.Zero, CryptProtectUiForbidden, ref output);
        if (!succeeded)
        {
            throw new SetupException("dpapi_operation_failed", new Win32Exception(Marshal.GetLastWin32Error()));
        }
        try
        {
            if (output.Data == IntPtr.Zero || output.Size is <= 0 or > MaxDpapiPayloadBytes)
            {
                throw new SetupException("dpapi_output_size_invalid");
            }
            var result = new byte[output.Size];
            Marshal.Copy(output.Data, result, 0, result.Length);
            return result;
        }
        finally
        {
            if (output.Data != IntPtr.Zero)
            {
                try
                {
                    if (output.Size > 0) ZeroUnmanagedBuffer(output.Data, output.Size);
                }
                finally
                {
                    _ = LocalFree(output.Data);
                }
            }
        }
    }

    internal static void ZeroUnmanagedBuffer(IntPtr buffer, int size)
    {
        if (buffer == IntPtr.Zero) throw new ArgumentException("buffer must not be null", nameof(buffer));
        if (size < 0) throw new ArgumentOutOfRangeException(nameof(size));
        if (size == 0) return;
        var zeros = new byte[Math.Min(size, ZeroBufferBytes)];
        var offset = 0;
        while (offset < size)
        {
            var count = Math.Min(zeros.Length, size - offset);
            Marshal.Copy(zeros, 0, IntPtr.Add(buffer, offset), count);
            offset += count;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DataBlob
    {
        internal int Size;
        internal IntPtr Data;
    }

    private sealed class DataBlobHandle : IDisposable
    {
        internal DataBlob Value;

        private DataBlobHandle(byte[] value)
        {
            Value.Size = value.Length;
            Value.Data = Marshal.AllocHGlobal(value.Length);
            Marshal.Copy(value, 0, Value.Data, value.Length);
        }

        internal static DataBlobHandle Create(byte[] value) => new(value);

        public void Dispose()
        {
            if (Value.Data == IntPtr.Zero) return;
            var zero = new byte[Value.Size];
            Marshal.Copy(zero, 0, Value.Data, zero.Length);
            Marshal.FreeHGlobal(Value.Data);
            Value.Data = IntPtr.Zero;
            CryptographicOperations.ZeroMemory(zero);
        }
    }

    [DllImport("Crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptProtectData(
        ref DataBlob dataIn,
        string description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        int flags,
        ref DataBlob dataOut);

    [DllImport("Crypt32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CryptUnprotectData(
        ref DataBlob dataIn,
        IntPtr description,
        ref DataBlob optionalEntropy,
        IntPtr reserved,
        IntPtr promptStruct,
        int flags,
        ref DataBlob dataOut);

    [DllImport("Kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
