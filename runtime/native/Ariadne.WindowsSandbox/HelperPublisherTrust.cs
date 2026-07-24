using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Ariadne.WindowsSandbox;

internal static class HelperPublisherTrust
{
    private const string PublisherMetadataName = "AriadneTrustedPublisherSha256";
    private static readonly Guid WinTrustActionGenericVerifyV2 =
        new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    internal static void EnsureCurrentExecutableTrusted()
    {
        var executablePath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
        {
            throw new SetupException("publisher_executable_unavailable");
        }

        var expectedPublisher = ReadExpectedPublisher();
        if (expectedPublisher is null)
        {
            throw new SetupException("publisher_trust_unconfigured");
        }
        if (!VerifyAuthenticode(executablePath))
        {
            throw new SetupException("publisher_signature_invalid");
        }

        string actualPublisher;
        try
        {
#pragma warning disable SYSLIB0057 // No loader API extracts the signer certificate from an Authenticode PE.
            using var certificate = new X509Certificate2(
                X509Certificate.CreateFromSignedFile(executablePath));
#pragma warning restore SYSLIB0057
            actualPublisher = certificate.GetCertHashString(HashAlgorithmName.SHA256)
                .ToLowerInvariant();
        }
        catch (CryptographicException error)
        {
            throw new SetupException("publisher_certificate_invalid", error);
        }

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(actualPublisher),
                Encoding.ASCII.GetBytes(expectedPublisher)))
        {
            throw new SetupException("publisher_identity_mismatch");
        }
    }

    private static string? ReadExpectedPublisher()
    {
        var values = Assembly.GetExecutingAssembly()
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .Where(attribute =>
                string.Equals(attribute.Key, PublisherMetadataName, StringComparison.Ordinal))
            .Select(attribute => attribute.Value?.Trim().ToLowerInvariant())
            .ToArray();
        if (values.Length != 1 || string.IsNullOrEmpty(values[0])) return null;
        var value = values[0]!;
        if (value.Length != 64 || value.Any(character => !Uri.IsHexDigit(character)))
        {
            throw new SetupException("publisher_trust_configuration_invalid");
        }
        return value;
    }

    private static bool VerifyAuthenticode(string executablePath)
    {
        var fileInfo = new WinTrustFileInfo(executablePath);
        var fileInfoPointer = Marshal.AllocHGlobal(Marshal.SizeOf(fileInfo));
        try
        {
            Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
            var trustData = new WinTrustData(fileInfoPointer);
            var status = WinVerifyTrust(
                IntPtr.Zero,
                WinTrustActionGenericVerifyV2,
                ref trustData);
            trustData.StateAction = WinTrustDataStateAction.Close;
            _ = WinVerifyTrust(
                IntPtr.Zero,
                WinTrustActionGenericVerifyV2,
                ref trustData);
            return status == 0;
        }
        finally
        {
            Marshal.DestroyStructure<WinTrustFileInfo>(fileInfoPointer);
            Marshal.FreeHGlobal(fileInfoPointer);
        }
    }

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int WinVerifyTrust(
        IntPtr windowHandle,
        [MarshalAs(UnmanagedType.LPStruct)] Guid actionId,
        ref WinTrustData trustData);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private sealed class WinTrustFileInfo
    {
        internal WinTrustFileInfo(string filePath)
        {
            StructSize = (uint)Marshal.SizeOf(this);
            FilePath = filePath;
        }

        private readonly uint StructSize;
        [MarshalAs(UnmanagedType.LPWStr)]
        private readonly string FilePath;
        private readonly IntPtr FileHandle = IntPtr.Zero;
        private readonly IntPtr KnownSubject = IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        internal WinTrustData(IntPtr fileInfo)
        {
            StructSize = (uint)Marshal.SizeOf<WinTrustData>();
            PolicyCallbackData = IntPtr.Zero;
            SipClientData = IntPtr.Zero;
            UiChoice = 2;
            RevocationChecks = 0;
            UnionChoice = 1;
            FileInfo = fileInfo;
            StateAction = WinTrustDataStateAction.Verify;
            StateData = IntPtr.Zero;
            UrlReference = IntPtr.Zero;
            ProviderFlags = 0x00001010;
            UiContext = 0;
            SignatureSettings = IntPtr.Zero;
        }

        private uint StructSize;
        private IntPtr PolicyCallbackData;
        private IntPtr SipClientData;
        private uint UiChoice;
        private uint RevocationChecks;
        private uint UnionChoice;
        private IntPtr FileInfo;
        internal WinTrustDataStateAction StateAction;
        private IntPtr StateData;
        private IntPtr UrlReference;
        private uint ProviderFlags;
        private uint UiContext;
        private IntPtr SignatureSettings;
    }

    private enum WinTrustDataStateAction : uint
    {
        Verify = 1,
        Close = 2,
    }
}
