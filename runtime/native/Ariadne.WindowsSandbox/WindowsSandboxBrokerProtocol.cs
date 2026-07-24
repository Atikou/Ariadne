using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Ariadne.WindowsSandbox;

internal sealed class BrokerExecutionEnvelope
{
    public required int Version { get; init; }
    public required ExecutionRequest Request { get; init; }
}

internal static class WindowsSandboxBrokerProtocol
{
    internal const int Version = 1;
    internal const int MaxRequestBytes = 2 * 1024 * 1024;
    internal const int ConnectTimeoutMilliseconds = 5_000;
    internal const PipeAccessRights ClientConnectionRights =
        PipeAccessRights.ReadData |
        PipeAccessRights.WriteData |
        PipeAccessRights.ReadExtendedAttributes |
        PipeAccessRights.WriteExtendedAttributes |
        PipeAccessRights.ReadAttributes |
        PipeAccessRights.WriteAttributes |
        PipeAccessRights.ReadPermissions;
    private const int PipeBufferBytes = 64 * 1024;

    internal static string PipeName(string stateRoot)
    {
        var canonical = PathPolicy.NormalizeAbsolute(stateRoot, "--state-root").ToUpperInvariant();
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        return $"Ariadne.WindowsSandbox.{digest[..24]}";
    }

    internal static NamedPipeServerStream CreateServer(string stateRoot, SecurityIdentifier ownerSid)
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            ownerSid,
            ClientConnectionRights,
            AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(
            PipeName(stateRoot),
            PipeDirection.InOut,
            8,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough,
            PipeBufferBytes,
            PipeBufferBytes,
            security,
            HandleInheritability.None,
            0);
    }

    internal static byte[] SerializeRequest(ExecutionRequest request)
    {
        var envelope = new BrokerExecutionEnvelope { Version = Version, Request = request };
        var payload = JsonSerializer.SerializeToUtf8Bytes(envelope, JsonProtocol.Options);
        if (payload.Length == 0 || payload.Length > MaxRequestBytes)
        {
            throw new NativeExecutionException("invalid_request", "broker request exceeds the protocol limit");
        }
        return payload;
    }

    internal static async Task WriteRequestAsync(
        Stream stream,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        await stream.WriteAsync(payload, cancellationToken);
        await stream.WriteAsync("\n"u8.ToArray(), cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    internal static async Task<ExecutionRequest> ReadRequestAsync(
        Stream stream,
        CancellationToken cancellationToken)
    {
        var payload = await ReadLineAsync(stream, MaxRequestBytes, cancellationToken);
        BrokerExecutionEnvelope envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<BrokerExecutionEnvelope>(payload, JsonProtocol.Options)
                ?? throw new RequestException("broker request must be a JSON object");
        }
        catch (JsonException error)
        {
            throw new RequestException($"invalid broker request: {error.Message}");
        }
        if (envelope.Version != Version) throw new RequestException("broker protocol version mismatch");
        ExecutionValidator.Validate(envelope.Request);
        return envelope.Request;
    }

    internal static async Task CopyResponseAsync(
        Stream source,
        Stream destination,
        int maxOutputBytes,
        CancellationToken cancellationToken)
    {
        var limit = checked((long)maxOutputBytes * 2 + 4 * 1024 * 1024);
        var buffer = new byte[64 * 1024];
        long total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            total += read;
            if (total > limit)
            {
                throw new NativeExecutionException("protocol_failure", "broker response exceeds the protocol limit");
            }
            await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            await destination.FlushAsync(cancellationToken);
        }
        if (total == 0)
        {
            throw new NativeExecutionException("protocol_failure", "broker closed without a protocol event");
        }
    }

    private static async Task<byte[]> ReadLineAsync(
        Stream stream,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        using var content = new MemoryStream();
        var buffer = new byte[16 * 1024];
        while (true)
        {
            var read = await stream.ReadAsync(buffer, cancellationToken);
            if (read == 0) throw new RequestException("broker request ended before newline");
            var newline = Array.IndexOf(buffer, (byte)'\n', 0, read);
            var count = newline < 0 ? read : newline;
            if (content.Length + count > maxBytes) throw new RequestException("broker request exceeds the protocol limit");
            content.Write(buffer, 0, count);
            if (newline < 0) continue;
            if (newline != read - 1) throw new RequestException("broker request contains trailing data");
            if (content.Length == 0) throw new RequestException("broker request is empty");
            return content.ToArray();
        }
    }
}

internal static class WindowsSandboxBrokerClient
{
    internal static async Task RunAsync(
        ExecutionRequest request,
        string stateRoot,
        CancellationToken cancellationToken = default)
    {
        var payload = WindowsSandboxBrokerProtocol.SerializeRequest(request);
        SandboxControlPlane.RequireExecutionManifest(stateRoot);
        using var pipe = new NamedPipeClientStream(
            ".",
            WindowsSandboxBrokerProtocol.PipeName(stateRoot),
            PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough,
            TokenImpersonationLevel.Impersonation);
        try
        {
            await pipe.ConnectAsync(
                WindowsSandboxBrokerProtocol.ConnectTimeoutMilliseconds,
                cancellationToken);
            await WindowsSandboxBrokerProtocol.WriteRequestAsync(pipe, payload, cancellationToken);
            await WindowsSandboxBrokerProtocol.CopyResponseAsync(
                pipe,
                Console.OpenStandardOutput(),
                request.MaxOutputBytes,
                cancellationToken);
        }
        catch (TimeoutException error)
        {
            throw new NativeExecutionException("setup_required", "sandbox broker is unavailable", innerException: error);
        }
        catch (IOException error)
        {
            throw new NativeExecutionException("setup_required", "sandbox broker connection failed", innerException: error);
        }
    }
}
