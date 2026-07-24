using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ariadne.WindowsSandbox;

internal sealed class SetupRequest
{
    public required string StateRoot { get; init; }
    public required string WorkspaceRoot { get; init; }
    public List<string> WritableRoots { get; init; } = [];
    public List<string> ToolReadRoots { get; init; } = [];
    public List<string> ReadOnlySubpaths { get; init; } = [];
    public string OfflineUser { get; init; } = "AriadneOffline";
    public string OnlineUser { get; init; } = "AriadneOnline";
    public string WriterGroup { get; init; } = "AriadneWriters";
    public bool AllowLoopback { get; init; }
}

internal sealed class ExecutionRequest
{
    public required string ExecutionId { get; init; }
    public required InvocationRequest Invocation { get; init; }
    public required string Cwd { get; init; }
    public required string WorkspaceRoot { get; init; }
    public WriteScopeRequest? WriteScope { get; init; }
    public List<string> WritableRoots { get; init; } = [];
    public List<string> ToolReadRoots { get; init; } = [];
    public List<string> ReadOnlySubpaths { get; init; } = [];
    public required string Mode { get; init; }
    public required string NetworkMode { get; init; }
    public Dictionary<string, string> Environment { get; init; } = new(StringComparer.OrdinalIgnoreCase);
    public int TimeoutMs { get; init; }
    public int MaxOutputBytes { get; init; }
    public string? StdinBase64 { get; init; }
    public bool Interactive { get; init; }
    public required ResourceLimits ResourceLimits { get; init; }
}

internal sealed class InteractiveInputFrame
{
    public required string Type { get; init; }
    public required string ExecutionId { get; init; }
    public string? DataBase64 { get; init; }
}

internal sealed class WriteScopeRequest
{
    public required string ScopeId { get; init; }
    public required string Root { get; init; }
}

internal sealed class InvocationRequest
{
    public required string Kind { get; init; }
    public string? File { get; init; }
    public List<string>? Args { get; init; }
    public string? Command { get; init; }
}

internal sealed class ResourceLimits
{
    public int MaxProcesses { get; init; }
    public long? MaxMemoryBytes { get; init; }
    public int? MaxCpuTimeMs { get; init; }
}

internal sealed class StatusResponse
{
    public required string Status { get; init; }
    public int Version { get; init; } = 5;
    public string? PolicyDigest { get; init; }
    public string? Reason { get; init; }
    public string? OfflineUser { get; init; }
    public string? OfflineUserSid { get; init; }
    public string? OnlineUser { get; init; }
    public string? OnlineUserSid { get; init; }
    public string? WriterGroup { get; init; }
    public string? WriterGroupSid { get; init; }
    public string? FilesystemCapabilitySid { get; init; }
    public string? FirewallRule { get; init; }
    public string? WorkspaceRoot { get; init; }
    public IReadOnlyList<string>? WritableRoots { get; init; }
    public IReadOnlyList<string>? ToolReadRoots { get; init; }
    public IReadOnlyList<string>? ReadOnlySubpaths { get; init; }
    public bool? AllowLoopback { get; init; }
}

internal sealed class SetupManifest
{
    public int Version { get; init; }
    public required string PolicyDigest { get; init; }
    public required string OwnerSid { get; init; }
    public required string OfflineUser { get; init; }
    public required string OfflineUserSid { get; init; }
    public required string OnlineUser { get; init; }
    public required string OnlineUserSid { get; init; }
    public required string WriterGroup { get; init; }
    public required string WriterGroupSid { get; init; }
    public string? FilesystemCapabilitySid { get; init; }
    public required string FirewallRule { get; init; }
    public required string WorkspaceRoot { get; init; }
    public List<string> WritableRoots { get; init; } = [];
    public List<string> ToolReadRoots { get; init; } = [];
    public List<string> ReadOnlySubpaths { get; init; } = [];
    public bool AllowLoopback { get; init; }
}

internal sealed class CredentialVaultRecord
{
    public int Version { get; init; } = 1;
    public required string OwnerSid { get; init; }
    public required string OfflineUser { get; init; }
    public required string OfflinePassword { get; init; }
    public required string OnlineUser { get; init; }
    public required string OnlinePassword { get; init; }
}

internal sealed record ManagedIdentity(
    string OfflineUserSid,
    string OnlineUserSid,
    string WriterGroupSid,
    string OfflinePassword,
    string OnlinePassword);

internal sealed record DesiredPolicy(
    string StateRoot,
    string WorkspaceRoot,
    IReadOnlyList<string> WritableRoots,
    IReadOnlyList<string> ToolReadRoots,
    IReadOnlyList<string> ReadOnlySubpaths,
    string OfflineUser,
    string OnlineUser,
    string WriterGroup,
    bool AllowLoopback,
    string Digest);

internal static class JsonProtocol
{
    internal static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };
}

internal sealed class RequestException(string message) : Exception(message);

internal sealed class SetupException(string code, Exception? innerException = null)
    : Exception(code, innerException)
{
    internal string Code { get; } = code;
}
