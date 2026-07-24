using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Ariadne.WindowsSandbox;

internal sealed class NativeProtocolWriter : INativeExecutionEventSink
{
    private readonly object writeLock = new();
    private readonly TextWriter output;

    internal static NativeProtocolWriter Console { get; } = new(System.Console.Out);

    internal NativeProtocolWriter(TextWriter output)
    {
        this.output = output ?? throw new ArgumentNullException(nameof(output));
    }

    internal void Authorized(
        string executionId,
        string policyDigest,
        string account,
        string accountSidHash,
        WriteScopeAuthorization? writeScope)
    {
        object authorization = writeScope is null
            ? new { policyDigest, account, accountSidHash }
            : new
            {
                policyDigest,
                account,
                accountSidHash,
                writeScope = new
                {
                    scopeId = writeScope.ScopeId,
                    root = writeScope.Root,
                    capabilitySidHash = HashSid(writeScope.CapabilitySid),
                },
            };
        Write(new
        {
            type = "authorized",
            executionId,
            authorization,
        });
    }

    public void Started(string executionId, int pid, NativeIsolation isolation) => Write(new
    {
        type = "started",
        executionId,
        pid,
        isolation,
    });

    public void Output(string executionId, bool isError, byte[] data) => Write(new
    {
        type = isError ? "stderr" : "stdout",
        executionId,
        dataBase64 = Convert.ToBase64String(data),
    });

    public void Result(string executionId, NativeExecutionResult result) => Write(new
    {
        type = "result",
        executionId,
        result,
    });

    internal void Error(
        string? executionId,
        string code,
        string message,
        bool retryable) => Write(new
    {
        type = "error",
        executionId,
        code,
        message,
        retryable,
    });

    private void Write<T>(T value)
    {
        var line = JsonSerializer.Serialize(value, JsonProtocol.Options);
        lock (writeLock)
        {
            output.WriteLine(line);
            output.Flush();
        }
    }

    private static string HashSid(string sid) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sid))).ToLowerInvariant();
}
