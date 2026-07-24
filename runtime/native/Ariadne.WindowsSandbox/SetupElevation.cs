using System.ComponentModel;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Ariadne.WindowsSandbox;

internal static class SetupElevation
{
    private const int ElevationCancelledError = 1223;
    private const int MaximumExchangeBytes = 1024 * 1024;
    private const int ElevationTimeoutMilliseconds = 10 * 60 * 1000;
    internal static StatusResponse Run(SetupRequest request, string stateRoot)
    {
        if (Environment.GetEnvironmentVariable("ARIADNE_SANDBOX_DISABLE_ELEVATION") == "1")
        {
            return SandboxControlPlane.BuildStatus(
                PathPolicy.Normalize(request, stateRoot),
                "setup_required",
                "administrator_required");
        }

        HelperPublisherTrust.EnsureCurrentExecutableTrusted();

        var ownerSid = WindowsIdentity.GetCurrent().User ?? throw new SetupException("owner_sid_unavailable");
        var exchangeRoot = Path.Combine(Path.GetTempPath(), $"AriadneSandboxSetup-{Guid.NewGuid():N}");
        var requestPath = Path.Combine(exchangeRoot, "request.json");
        try
        {
            Directory.CreateDirectory(exchangeRoot);
            StateStorage.ApplyExchangeDirectoryAcl(exchangeRoot, ownerSid);
            var requestJson = JsonSerializer.Serialize(request, JsonProtocol.Options);
            File.WriteAllText(requestPath, requestJson);
            StateStorage.ApplyExchangeFileAcl(requestPath, ownerSid);
            var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(requestJson)));
            var helperPath = Environment.ProcessPath;
            if (!File.Exists(helperPath)) throw new SetupException("elevation_helper_path_invalid");

            var startInfo = new ProcessStartInfo
            {
                FileName = helperPath,
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            foreach (var argument in new[]
                     {
                         "setup-elevated",
                         "--state-root", stateRoot,
                         "--owner-sid", ownerSid.Value,
                         "--request-file", requestPath,
                         "--request-digest", digest,
                     })
            {
                startInfo.ArgumentList.Add(argument);
            }

            Process process;
            try
            {
                process = Process.Start(startInfo) ?? throw new SetupException("elevation_process_start_failed");
            }
            catch (Win32Exception error) when (error.NativeErrorCode == ElevationCancelledError)
            {
                return SandboxControlPlane.BuildStatus(
                    PathPolicy.Normalize(request, stateRoot),
                    "setup_required",
                    "elevation_cancelled");
            }
            using (process)
            {
                if (!process.WaitForExit(ElevationTimeoutMilliseconds))
                {
                    try { process.Kill(true); } catch (Exception) { }
                    throw new SetupException("elevation_process_timed_out");
                }
            }
            // The elevated process has no write channel back into the caller-owned exchange directory.
            return SandboxControlPlane.GetStatus(request, stateRoot);
        }
        finally
        {
            try { Directory.Delete(exchangeRoot, true); } catch (Exception) { }
        }
    }

    internal static int RunElevated(IReadOnlyList<string> args)
    {
        try
        {
            if (args.Count != 9 ||
                args[1] != "--state-root" ||
                args[3] != "--owner-sid" ||
                args[5] != "--request-file" ||
                args[7] != "--request-digest")
            {
                return 2;
            }
            var stateRoot = PathPolicy.NormalizeAbsolute(args[2], "--state-root");
            var ownerSid = ParseOwnerSid(args[4]);
            var requestPath = PathPolicy.NormalizeAbsolute(args[6], "--request-file");
            var expectedDigest = args[8];
            ValidateExchangePath(requestPath, expectedDigest);
            if (!SetupService.IsAdministrator()) throw new SetupException("elevation_token_missing");
            HelperPublisherTrust.EnsureCurrentExecutableTrusted();
            var elevatedSid = WindowsIdentity.GetCurrent().User;
            if (elevatedSid is null || !elevatedSid.Equals(ownerSid))
            {
                throw new SetupException("elevation_identity_mismatch");
            }

            var requestJson = ReadVerifiedRequest(requestPath, expectedDigest);
            var request = JsonSerializer.Deserialize<SetupRequest>(requestJson, JsonProtocol.Options)
                ?? throw new SetupException("elevation_request_invalid");
            _ = SetupService.Apply(request, stateRoot);
            return 0;
        }
        catch (SetupException)
        {
            return 3;
        }
        catch (Exception)
        {
            return 2;
        }
    }

    private static void ValidateExchangePath(string requestPath, string digest)
    {
        var requestDirectory = Path.GetDirectoryName(requestPath);
        if (requestDirectory is null ||
            !Path.GetFileName(requestDirectory).StartsWith("AriadneSandboxSetup-", StringComparison.Ordinal) ||
            !PathPolicy.IsSameOrDescendant(
                requestDirectory,
                PathPolicy.NormalizeAbsolute(Path.GetTempPath(), "temporary directory")) ||
            !string.Equals(Path.GetFileName(requestPath), "request.json", StringComparison.Ordinal) ||
            digest.Length != 64 || digest.Any(character => !Uri.IsHexDigit(character)))
        {
            throw new SetupException("elevation_exchange_invalid");
        }
    }

    private static SecurityIdentifier ParseOwnerSid(string value)
    {
        try
        {
            var sid = new SecurityIdentifier(value);
            if (!string.Equals(sid.Value, value, StringComparison.Ordinal))
            {
                throw new SetupException("elevation_owner_sid_invalid");
            }
            return sid;
        }
        catch (ArgumentException error)
        {
            throw new SetupException("elevation_owner_sid_invalid", error);
        }
    }

    internal static string ReadVerifiedRequest(string path, string expectedDigest)
    {
        try
        {
            using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.SequentialScan);
            EnsureRequestIdentity(stream, path);
            if (stream.Length is <= 0 or > MaximumExchangeBytes)
            {
                throw new SetupException("elevation_request_invalid");
            }
            using var reader = new StreamReader(
                stream,
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true),
                detectEncodingFromByteOrderMarks: false,
                bufferSize: 4096,
                leaveOpen: true);
            var requestJson = reader.ReadToEnd();
            EnsureRequestIdentity(stream, path);
            var actualDigest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(requestJson)));
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.ASCII.GetBytes(actualDigest),
                    Encoding.ASCII.GetBytes(expectedDigest)))
            {
                throw new SetupException("elevation_request_digest_mismatch");
            }
            return requestJson;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or DecoderFallbackException)
        {
            throw new SetupException("elevation_request_invalid", error);
        }
    }

    private static void EnsureRequestIdentity(FileStream stream, string expectedPath)
    {
        var actualPath = WindowsPathResolver.ResolveHandle(stream.SafeFileHandle);
        if (!PathPolicy.PathEquals(actualPath, expectedPath))
        {
            throw new SetupException("elevation_request_identity_changed");
        }
    }
}
