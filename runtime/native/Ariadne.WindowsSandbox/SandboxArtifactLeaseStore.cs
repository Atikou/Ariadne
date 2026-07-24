using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace Ariadne.WindowsSandbox;

internal sealed class SandboxArtifactLeaseJournal
{
    public required int Version { get; init; }
    public required List<SandboxArtifactLease> Leases { get; init; }
}

internal sealed class SandboxArtifactLease
{
    public required string ExecutionId { get; init; }
    public required string AccountSid { get; init; }
    public required string TempRoot { get; init; }
    public required string FilesystemCapabilitySid { get; init; }
    public required string PolicyDigest { get; init; }
}

internal sealed class SandboxArtifactLeaseStore
{
    private const int MaxLeases = 256;
    private const long MaxJournalBytes = 1024 * 1024;
    private static readonly object Gate = new();
    private static readonly HashSet<string> ActiveLeases = new(StringComparer.Ordinal);

    private readonly string stateRoot;
    private readonly SecurityIdentifier ownerSid;

    internal SandboxArtifactLeaseStore(string stateRoot, SecurityIdentifier ownerSid)
    {
        this.stateRoot = PathPolicy.NormalizeAbsolute(stateRoot, "stateRoot");
        this.ownerSid = ownerSid;
    }

    internal void RecoverAndRegister(
        SafeAccessTokenHandle accountToken,
        SandboxArtifactLease current)
    {
        lock (Gate)
        {
            var journal = LoadVerified();
            ValidateLease(current);
            var currentKey = ActiveKey(current.ExecutionId);
            if (ActiveLeases.Contains(currentKey))
            {
                throw new NativeExecutionException(
                    "process_start_failure",
                    "sandbox execution id is already active");
            }

            var recoverable = journal.Leases
                .Where(lease =>
                    string.Equals(lease.AccountSid, current.AccountSid, StringComparison.Ordinal) &&
                    !ActiveLeases.Contains(ActiveKey(lease.ExecutionId)))
                .ToArray();
            foreach (var lease in recoverable)
            {
                RequireCompatibleRecoveryLease(lease, current);
                WindowsSandboxArtifactCleaner.Delete(accountToken, lease);
            }

            journal.Leases.RemoveAll(lease => recoverable.Contains(lease));
            if (journal.Leases.Any(lease =>
                    string.Equals(lease.ExecutionId, current.ExecutionId, StringComparison.Ordinal)))
            {
                throw new NativeExecutionException(
                    "sandbox_cleanup_failure",
                    "sandbox execution id collides with an unrecoverable artifact lease");
            }
            journal.Leases.Add(current);
            Save(journal);
            ActiveLeases.Add(currentKey);
        }
    }

    internal void Complete(SandboxArtifactLease lease)
    {
        lock (Gate)
        {
            try
            {
                var journal = LoadVerified();
                var removed = journal.Leases.RemoveAll(candidate =>
                    string.Equals(candidate.ExecutionId, lease.ExecutionId, StringComparison.Ordinal) &&
                    string.Equals(candidate.AccountSid, lease.AccountSid, StringComparison.Ordinal));
                if (removed != 1)
                {
                    throw new NativeExecutionException(
                        "sandbox_cleanup_failure",
                        "sandbox artifact lease completion did not match one record");
                }
                Save(journal);
            }
            finally
            {
                ActiveLeases.Remove(ActiveKey(lease.ExecutionId));
            }
        }
    }

    internal void Abandon(SandboxArtifactLease lease)
    {
        lock (Gate) ActiveLeases.Remove(ActiveKey(lease.ExecutionId));
    }

    internal void RecoverForSetup(DesiredPolicy previousPolicy, SetupManifest previousManifest)
    {
        lock (Gate)
        {
            SandboxArtifactLeaseJournal journal;
            try
            {
                journal = LoadVerified();
            }
            catch (Exception error) when (error is NativeExecutionException or SetupException)
            {
                throw new SetupException("sandbox_artifact_lease_invalid", error);
            }
            if (journal.Leases.Count == 0) return;
            if (ActiveLeases.Any(key => key.StartsWith(StateKeyPrefix(), StringComparison.Ordinal)))
            {
                throw new SetupException("sandbox_artifact_recovery_active");
            }
            var filesystemCapability = previousManifest.FilesystemCapabilitySid;
            if (previousManifest.Version != 2 || string.IsNullOrWhiteSpace(filesystemCapability))
            {
                throw new SetupException("sandbox_artifact_lease_manifest_invalid");
            }
            foreach (var lease in journal.Leases)
            {
                if (!string.Equals(lease.PolicyDigest, previousManifest.PolicyDigest, StringComparison.Ordinal) ||
                    !string.Equals(lease.FilesystemCapabilitySid, filesystemCapability, StringComparison.Ordinal) ||
                    lease.AccountSid != previousManifest.OfflineUserSid &&
                    lease.AccountSid != previousManifest.OnlineUserSid)
                {
                    throw new SetupException("sandbox_artifact_lease_policy_mismatch");
                }
            }

            var passwords = CredentialVault.Load(previousPolicy, ownerSid);
            SafeAccessTokenHandle? offlineToken = null;
            SafeAccessTokenHandle? onlineToken = null;
            try
            {
                if (journal.Leases.Any(lease => lease.AccountSid == previousManifest.OfflineUserSid))
                {
                    offlineToken = WindowsBatchLogon.Logon(
                        previousManifest.OfflineUser,
                        passwords.OfflinePassword);
                }
                if (journal.Leases.Any(lease => lease.AccountSid == previousManifest.OnlineUserSid))
                {
                    onlineToken = WindowsBatchLogon.Logon(
                        previousManifest.OnlineUser,
                        passwords.OnlinePassword);
                }
                foreach (var lease in journal.Leases)
                {
                    var token = lease.AccountSid == previousManifest.OfflineUserSid
                        ? offlineToken
                        : onlineToken;
                    if (token is null)
                    {
                        throw new SetupException("sandbox_artifact_recovery_token_missing");
                    }
                    var expectedTempRoot = PathPolicy.NormalizeAbsolute(
                        WindowsUserEnvironmentBlock.ReadRequiredVariable(token, "TEMP"),
                        "sandboxAccount.TEMP");
                    if (!PathPolicy.PathEquals(lease.TempRoot, expectedTempRoot))
                    {
                        throw new SetupException("sandbox_artifact_lease_temp_root_mismatch");
                    }
                    WindowsSandboxArtifactCleaner.Delete(token, lease);
                }
                Save(EmptyJournal());
            }
            catch (SetupException)
            {
                throw;
            }
            catch (Exception error)
            {
                throw new SetupException("sandbox_artifact_recovery_failed", error);
            }
            finally
            {
                offlineToken?.Dispose();
                onlineToken?.Dispose();
            }
        }
    }

    internal static bool Verify(
        string stateRoot,
        SecurityIdentifier ownerSid,
        SetupManifest manifest)
    {
        try
        {
            var store = new SandboxArtifactLeaseStore(stateRoot, ownerSid);
            var journal = store.LoadVerified();
            return journal.Leases.All(lease =>
                string.Equals(lease.PolicyDigest, manifest.PolicyDigest, StringComparison.Ordinal) &&
                string.Equals(
                    lease.FilesystemCapabilitySid,
                    manifest.FilesystemCapabilitySid,
                    StringComparison.Ordinal) &&
                (lease.AccountSid == manifest.OfflineUserSid ||
                 lease.AccountSid == manifest.OnlineUserSid));
        }
        catch (Exception error) when (
            error is SetupException or NativeExecutionException or IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    internal static void ValidateJournalForTest(SandboxArtifactLeaseJournal journal) =>
        ValidateJournal(journal);

    private SandboxArtifactLeaseJournal LoadVerified()
    {
        var path = Path.Combine(stateRoot, StateStorage.ArtifactLeaseFileName);
        if (!File.Exists(path)) return EmptyJournal();
        if (!StateStorage.VerifyFile(path, ownerSid))
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "sandbox artifact lease journal ACL is invalid");
        }
        SandboxArtifactLeaseJournal journal;
        try
        {
            journal = StateStorage.ReadJson<SandboxArtifactLeaseJournal>(
                stateRoot,
                StateStorage.ArtifactLeaseFileName,
                MaxJournalBytes) ?? EmptyJournal();
        }
        catch (Exception error) when (
            error is System.Text.Json.JsonException or IOException or UnauthorizedAccessException or SetupException)
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "sandbox artifact lease journal is invalid",
                innerException: error);
        }
        ValidateJournal(journal);
        return journal;
    }

    private void Save(SandboxArtifactLeaseJournal journal)
    {
        ValidateJournal(journal);
        try
        {
            StateStorage.WriteJsonAtomic(
                stateRoot,
                StateStorage.ArtifactLeaseFileName,
                journal,
                ownerSid);
        }
        catch (Exception error) when (error is SetupException or IOException or UnauthorizedAccessException)
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "sandbox artifact lease journal could not be persisted",
                innerException: error);
        }
    }

    private static void ValidateJournal(SandboxArtifactLeaseJournal journal)
    {
        if (journal.Version != 1 || journal.Leases is null || journal.Leases.Count > MaxLeases)
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "sandbox artifact lease journal shape is invalid");
        }
        var executionIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var lease in journal.Leases)
        {
            if (lease is null)
            {
                throw new NativeExecutionException(
                    "sandbox_cleanup_failure",
                    "sandbox artifact lease journal contains a null record");
            }
            ValidateLease(lease);
            if (!executionIds.Add(lease.ExecutionId))
            {
                throw new NativeExecutionException(
                    "sandbox_cleanup_failure",
                    "sandbox artifact lease journal contains duplicate execution ids");
            }
        }
    }

    private static void ValidateLease(SandboxArtifactLease lease)
    {
        if (string.IsNullOrWhiteSpace(lease.ExecutionId) || lease.ExecutionId.Length > 512 ||
            string.IsNullOrWhiteSpace(lease.AccountSid) ||
            string.IsNullOrWhiteSpace(lease.TempRoot) ||
            string.IsNullOrWhiteSpace(lease.FilesystemCapabilitySid) ||
            !lease.FilesystemCapabilitySid.StartsWith("S-1-15-3-", StringComparison.Ordinal) ||
            lease.PolicyDigest is null || lease.PolicyDigest.Length != 64 ||
            lease.PolicyDigest.Any(character => !Uri.IsHexDigit(character)))
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "sandbox artifact lease identity is invalid");
        }
        try
        {
            var accountSid = new SecurityIdentifier(lease.AccountSid);
            var capabilitySid = new SecurityIdentifier(lease.FilesystemCapabilitySid);
            var tempRoot = PathPolicy.NormalizeAbsolute(lease.TempRoot, "artifactLease.tempRoot");
            if (!string.Equals(accountSid.Value, lease.AccountSid, StringComparison.Ordinal) ||
                !string.Equals(capabilitySid.Value, lease.FilesystemCapabilitySid, StringComparison.Ordinal) ||
                !PathPolicy.PathEquals(tempRoot, lease.TempRoot))
            {
                throw new RequestException("artifact lease identity is not canonical");
            }
        }
        catch (Exception error) when (error is ArgumentException or RequestException)
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "sandbox artifact lease boundary is invalid",
                innerException: error);
        }
    }

    private static void RequireCompatibleRecoveryLease(
        SandboxArtifactLease stale,
        SandboxArtifactLease current)
    {
        if (!string.Equals(stale.PolicyDigest, current.PolicyDigest, StringComparison.Ordinal) ||
            !string.Equals(
                stale.FilesystemCapabilitySid,
                current.FilesystemCapabilitySid,
                StringComparison.Ordinal) ||
            !PathPolicy.PathEquals(stale.TempRoot, current.TempRoot))
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "stale sandbox artifact lease does not match the active policy");
        }
    }

    private string ActiveKey(string executionId) => StateKeyPrefix() + executionId;

    private string StateKeyPrefix() => stateRoot.ToUpperInvariant() + "\0";

    private static SandboxArtifactLeaseJournal EmptyJournal() => new()
    {
        Version = 1,
        Leases = [],
    };
}

internal static class WindowsSandboxArtifactCleaner
{
    internal static void Delete(
        SafeAccessTokenHandle token,
        SandboxArtifactLease lease)
    {
        try
        {
            WindowsIdentity.RunImpersonated(token, () => DeleteAsCurrentIdentity(lease));
        }
        catch (NativeExecutionException)
        {
            throw;
        }
        catch (Exception error)
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "sandbox account cleanup impersonation failed",
                innerException: error);
        }
    }

    private static void DeleteAsCurrentIdentity(SandboxArtifactLease lease)
    {
        var filesystemCapability = new SecurityIdentifier(lease.FilesystemCapabilitySid);
        Exception? firstFailure = null;
        try
        {
            WindowsRuntimeDirectory.DeleteEphemeral(
                lease.TempRoot,
                lease.ExecutionId,
                filesystemCapability);
        }
        catch (Exception error)
        {
            firstFailure = error;
        }
        try
        {
            WindowsAppContainerProfile.DeleteEphemeral(
                lease.ExecutionId,
                filesystemCapability);
        }
        catch (Exception error)
        {
            firstFailure ??= error;
        }
        if (firstFailure is not null)
        {
            throw new NativeExecutionException(
                "sandbox_cleanup_failure",
                "ephemeral sandbox artifact cleanup failed",
                innerException: firstFailure);
        }
    }
}
