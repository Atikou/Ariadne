namespace Ariadne.WindowsSandbox;

internal sealed class ExecutionAuthorization
{
    private string? password;

    internal ExecutionAuthorization(
        DesiredPolicy policy,
        SetupManifest manifest,
        string accountName,
        string accountSid,
        string password,
        string restrictionSid,
        WriteScopeAuthorization? writeScope)
    {
        Policy = policy;
        Manifest = manifest;
        AccountName = accountName;
        AccountSid = accountSid;
        this.password = password;
        RestrictionSid = restrictionSid;
        WriteScope = writeScope;
    }

    internal DesiredPolicy Policy { get; }
    internal SetupManifest Manifest { get; }
    internal string AccountName { get; }
    internal string AccountSid { get; }
    internal string RestrictionSid { get; }
    internal WriteScopeAuthorization? WriteScope { get; }

    internal T UsePasswordOnce<T>(Func<string, T> operation)
    {
        ArgumentNullException.ThrowIfNull(operation);
        var value = Interlocked.Exchange(ref password, null);
        if (value is null)
        {
            throw new NativeExecutionException(
                "credential_failure",
                "execution credential has already been consumed");
        }
        return operation(value);
    }
}

internal sealed record WriteScopeAuthorization(
    string ScopeId,
    string Root,
    string CapabilitySid);

internal sealed record RunnerIdentity(
    string ExpectedAccountSid,
    string WriterGroupSid,
    string RestrictionSid,
    string FilesystemCapabilitySid,
    bool RequireWriterMembership);

internal sealed class NativeIsolation
{
    public string Backend { get; init; } = "windows-native";
    public bool Enforced { get; init; } = true;
    public required string Mode { get; init; }
    public required string NetworkMode { get; init; }
    public required string Account { get; init; }
    public bool RestrictedToken { get; init; } = true;
    public bool FilesystemAcl { get; init; } = true;
    public bool AppContainer { get; init; } = true;
    public bool FilesystemReadRestricted { get; init; } = true;
    public bool CredentialIsolation { get; init; } = true;
    public bool PublicObjectWriteRestricted { get; init; } = true;
    public required bool Firewall { get; init; }
    public bool JobObject { get; init; } = true;
    public bool PrivateDesktop { get; init; } = true;
    public string Environment { get; init; } = "allowlist";
    public bool ProcessTreeTermination { get; init; } = true;
}

internal sealed class NativeExecutionResult
{
    public required string ExecutionId { get; init; }
    public int? ExitCode { get; init; }
    public required string Stdout { get; init; }
    public required string Stderr { get; init; }
    public bool TimedOut { get; init; }
    public bool Truncated { get; init; }
    public bool SpawnFailed { get; init; }
    public string? ErrorCode { get; init; }
    public required NativeIsolation Isolation { get; init; }
}

internal sealed class NativeExecutionException(
    string code,
    string message,
    bool retryable = false,
    Exception? innerException = null)
    : Exception(message, innerException)
{
    internal string Code { get; } = code;
    internal bool Retryable { get; } = retryable;
}

internal interface INativeExecutionEventSink
{
    void Started(string executionId, int pid, NativeIsolation isolation);
    void Output(string executionId, bool isError, byte[] data);
    void Result(string executionId, NativeExecutionResult result);
}
