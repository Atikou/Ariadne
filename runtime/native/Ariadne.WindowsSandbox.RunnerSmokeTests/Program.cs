using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Ariadne.WindowsSandbox;
using Microsoft.Win32.SafeHandles;

if (args is ["--probe-inherited-file-handle", var rawHandle, var expectedPath])
{
    if (!long.TryParse(rawHandle, out var handleValue)) return 90;
    using var candidate = new SafeFileHandle(new IntPtr(handleValue), ownsHandle: false);
    try
    {
        if (!NativeHandleProbe.IsDiskFile(candidate)) return 0;
        var actualPath = WindowsPathResolver.ResolveHandle(candidate);
        return PathPolicy.PathEquals(actualPath, Path.GetFullPath(expectedPath)) ? 91 : 0;
    }
    catch (Exception error) when (error is RequestException or SEHException)
    {
        return 0;
    }
}

if (args is ["--probe-runtime-symlink", var linkPath, var targetPath, var linkedFilePath])
{
    return RuntimeSymlinkProbe.Run(linkPath, targetPath, linkedFilePath);
}

if (args is ["--probe-private-desktop"])
{
    return DesktopIsolationProbe.Run();
}

if (args is ["--cleanup-appcontainer", var executionId, var rawFilesystemCapabilitySid])
{
    var capabilitySid = new SecurityIdentifier(rawFilesystemCapabilitySid);
    WindowsRuntimeDirectory.DeleteEphemeral(
        Path.GetTempPath(),
        executionId,
        capabilitySid);
    WindowsAppContainerProfile.DeleteEphemeral(
        executionId,
        capabilitySid);
    Console.WriteLine("runtime_directory_cleanup_ok");
    Console.WriteLine("appcontainer_profile_cleanup_ok");
    return 0;
}

if (args is ["--probe-process-limit", var sentinelPath])
{
    try
    {
        using var child = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = Environment.ProcessPath
                ?? throw new InvalidOperationException("process_limit_probe_apphost_missing"),
            UseShellExecute = false,
            ArgumentList = { "--probe-write-sentinel", sentinelPath },
        });
        if (child is null) return 96;
        if (!child.WaitForExit(2_000)) return 97;
        if (File.Exists(sentinelPath)) return 98;
    }
    catch (Win32Exception)
    {
    }
    Console.WriteLine("active_process_limit_blocked_descendant");
    return 0;
}

if (args is ["--probe-write-sentinel", var sentinelPathToWrite])
{
    File.WriteAllText(sentinelPathToWrite, "escaped");
    return 0;
}

if (args is ["--probe-memory-limit"])
{
    var allocations = new List<byte[]>();
    while (true)
    {
        var block = GC.AllocateUninitializedArray<byte>(8 * 1024 * 1024);
        block.AsSpan().Fill(0x5A);
        allocations.Add(block);
    }
}

if (args is ["--probe-cpu-limit"])
{
    while (true) Thread.SpinWait(100_000);
}

const string supervisedMarker = "--inside-supervisor-job";
if (args.Length == 0 || !string.Equals(args[0], supervisedMarker, StringComparison.Ordinal))
{
    return await RunInsideSupervisorJobAsync(args, supervisedMarker);
}
args = args[1..];

if (args is ["--toolchain-bypass", var gitPath, var pythonPath, var npmPath, var nodePath])
{
    await ToolchainBypassSmoke.RunAsync(gitPath, pythonPath, npmPath, nodePath);
    Console.WriteLine("toolchain_bypass_smoke_ok");
    return 0;
}

VerifyGroupMemberPagination();
VerifyElevationRequestContract();
VerifyCredentialBufferZeroing();
VerifyOneShotExecutionCredential();
VerifySandboxArtifactLeaseJournalContract();
VerifyAccountVisibilityContract();
VerifyAccountLogonPolicyContract();
VerifyBrokerServiceConfigurationContract();
VerifyBrokerIdentityContract();
await VerifyBrokerPipeContractAsync();
VerifyExecutionInputProtocolContract();

using var currentIdentity = WindowsIdentity.GetCurrent();
if (new WindowsPrincipal(currentIdentity).IsInRole(WindowsBuiltInRole.Administrator))
{
    Console.WriteLine("restricted_runner_smoke_skipped_elevated_admin");
    return 0;
}

var currentSid = currentIdentity.User
    ?? throw new InvalidOperationException("current_user_sid_missing");
var usersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
var writeCapabilitySid = new SecurityIdentifier("S-1-5-21-999999981-999999982-999999983-1901");
var filesystemCapabilitySid = WindowsAppContainerProfile.DeriveCapabilitySid(
    $"Ariadne.runner-smoke.{Guid.NewGuid():N}");
var root = Path.Combine(Path.GetTempPath(), $"ariadne-runner-smoke-{Guid.NewGuid():N}");
var workspace = Path.Combine(root, "workspace");
var external = Path.Combine(root, "external");
var worldWritable = Path.Combine(root, "world-writable");
var runtimeJunction = Path.Combine(workspace, "runtime-junction");
var runtimeSymlink = Path.Combine(workspace, "runtime-symlink");
var profileSentinel = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
    $".ariadne-profile-read-{Guid.NewGuid():N}.txt");
Directory.CreateDirectory(workspace);
Directory.CreateDirectory(external);
Directory.CreateDirectory(worldWritable);
var rootSecurity = new DirectoryInfo(root).GetAccessControl(AccessControlSections.Access);
var sourceExecutable = Path.ChangeExtension(typeof(CapturingSink).Assembly.Location, ".exe");
Require(File.Exists(sourceExecutable), "runner_smoke_apphost_missing");
var probeToolRoot = Path.Combine(workspace, "probe-tool");
Directory.CreateDirectory(probeToolRoot);
foreach (var sourceFile in Directory.GetFiles(Path.GetDirectoryName(sourceExecutable)!))
{
    File.Copy(sourceFile, Path.Combine(probeToolRoot, Path.GetFileName(sourceFile)));
}
var selfExecutable = Path.Combine(probeToolRoot, Path.GetFileName(sourceExecutable));

try
{
    File.WriteAllText(profileSentinel, "profile-must-not-be-readable");
    ConfigureBoundary(workspace, usersSid, writeCapabilitySid, filesystemCapabilitySid);
    ConfigureBoundary(external, usersSid, restrictedCapability: null);
    ConfigureBoundary(
        worldWritable,
        new SecurityIdentifier(WellKnownSidType.WorldSid, null),
        restrictedCapability: null);

    var workspaceFile = Path.Combine(workspace, "workspace-write.txt");
    var writeResult = await RunAsync(
        Request("workspace-write", workspace, $"echo workspace-ok>\"{workspaceFile}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(writeResult.ExitCode == 0 && File.ReadAllText(workspaceFile).Contains("workspace-ok", StringComparison.Ordinal),
        "workspace_write_was_not_allowed");
    Require(
        writeResult.Isolation.AppContainer &&
        writeResult.Isolation.FilesystemReadRestricted &&
        writeResult.Isolation.CredentialIsolation &&
        writeResult.Isolation.PublicObjectWriteRestricted,
        "appcontainer_isolation_was_not_reported");

    var externalFile = Path.Combine(external, "escape.txt");
    var externalResult = await RunAsync(
        Request("workspace-write", workspace, $"echo escaped>\"{externalFile}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(externalResult.ExitCode != 0 && !File.Exists(externalFile), "external_write_was_not_blocked");
    var externalSecret = Path.Combine(external, "outside-secret.txt");
    File.WriteAllText(externalSecret, "must-not-be-readable");
    var externalRead = await RunAsync(
        Request("read-only", workspace, $"type \"{externalSecret}\""),
        currentSid,
        writeCapabilitySid,
        new SecurityIdentifier("S-1-5-12"));
    Require(
        externalRead.ExitCode != 0 &&
        !externalRead.Stdout.Contains("must-not-be-readable", StringComparison.Ordinal),
        "external_read_was_not_blocked");
    var profileRead = await RunAsync(
        Request("read-only", workspace, $"type \"{profileSentinel}\""),
        currentSid,
        writeCapabilitySid,
        new SecurityIdentifier("S-1-5-12"));
    Require(
        profileRead.ExitCode != 0 &&
        !profileRead.Stdout.Contains("profile-must-not-be-readable", StringComparison.Ordinal),
        "user_profile_read_was_not_blocked");

    var longWorkspace = WindowsPathResolver.Canonicalize(workspace);
    var longExternal = WindowsPathResolver.Canonicalize(external);
    var shortWorkspace = WindowsShortPathProbe.Resolve(workspace);
    var shortExternal = WindowsShortPathProbe.Resolve(external);
    Require(
        shortWorkspace.Contains('~') &&
        shortExternal.Contains('~') &&
        !string.Equals(shortWorkspace, longWorkspace, StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(shortExternal, longExternal, StringComparison.OrdinalIgnoreCase),
        "runtime_8dot3_alias_unavailable");
    var shortAliasFile = Path.Combine(shortWorkspace, "short-alias-write.txt");
    var shortAliasWrite = await RunAsync(
        Request("workspace-write", longWorkspace, $"echo short-ok>\"{shortAliasFile}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        shortAliasWrite.ExitCode == 0 &&
        File.ReadAllText(Path.Combine(workspace, "short-alias-write.txt")).Contains("short-ok", StringComparison.Ordinal),
        "runtime_8dot3_workspace_alias_was_not_allowed");
    var shortAliasEscape = Path.Combine(shortExternal, "short-alias-escape.txt");
    var shortAliasExternalWrite = await RunAsync(
        Request("workspace-write", longWorkspace, $"echo escaped>\"{shortAliasEscape}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        shortAliasExternalWrite.ExitCode != 0 &&
        !File.Exists(Path.Combine(external, "short-alias-escape.txt")),
        "runtime_8dot3_external_alias_was_not_blocked");
    Console.WriteLine("runtime_8dot3_alias_matrix_ok");

    var caseWorkspace = longWorkspace.ToUpperInvariant();
    var caseExternal = longExternal.ToUpperInvariant();
    Require(
        !string.Equals(caseWorkspace, longWorkspace, StringComparison.Ordinal) &&
        PathPolicy.PathEquals(caseWorkspace, longWorkspace),
        "runtime_case_alias_unavailable");
    var caseAliasFile = Path.Combine(caseWorkspace, "case-alias-write.txt");
    var caseAliasWrite = await RunAsync(
        Request("workspace-write", longWorkspace, $"echo case-ok>\"{caseAliasFile}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        caseAliasWrite.ExitCode == 0 &&
        File.ReadAllText(Path.Combine(workspace, "case-alias-write.txt")).Contains("case-ok", StringComparison.Ordinal),
        "runtime_case_workspace_alias_was_not_allowed");
    var caseAliasEscape = Path.Combine(caseExternal, "case-alias-escape.txt");
    var caseAliasExternalWrite = await RunAsync(
        Request("workspace-write", longWorkspace, $"echo escaped>\"{caseAliasEscape}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        caseAliasExternalWrite.ExitCode != 0 &&
        !File.Exists(Path.Combine(external, "case-alias-escape.txt")),
        "runtime_case_external_alias_was_not_blocked");
    Console.WriteLine("runtime_case_alias_matrix_ok");

    var junctionEscape = Path.Combine(external, "junction-escape.txt");
    var junctionResult = await RunAsync(
        Request(
            "workspace-write",
            workspace,
            $"mklink /J \"{runtimeJunction}\" \"{external}\" >nul && echo escaped>\"{Path.Combine(runtimeJunction, "junction-escape.txt")}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    var junctionCreated = Directory.Exists(runtimeJunction) &&
        (File.GetAttributes(runtimeJunction) & FileAttributes.ReparsePoint) != 0;
    Require(
        junctionResult.ExitCode != 0 && !File.Exists(junctionEscape),
        "runtime_junction_external_write_was_not_blocked");
    Console.WriteLine(junctionCreated
        ? "runtime_junction_created_write_blocked"
        : "runtime_junction_creation_blocked");
    if (junctionCreated) Directory.Delete(runtimeJunction);

    var symlinkEscape = Path.Combine(external, "symlink-escape.txt");
    var symlinkResult = await RunAsync(
        Request(
            "workspace-write",
            workspace,
            command: "",
            invocation: new InvocationRequest
            {
                Kind = "file",
                File = selfExecutable,
                Args =
                [
                    "--probe-runtime-symlink",
                    runtimeSymlink,
                    external,
                    Path.Combine(runtimeSymlink, "symlink-escape.txt"),
                ],
            }),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    var symlinkCreated =
        symlinkResult.Stdout.Contains("runtime_symlink_reparse_created", StringComparison.Ordinal);
    var symlinkCreationBlocked =
        symlinkResult.Stdout.Contains("runtime_symlink_creation_blocked:", StringComparison.Ordinal);
    var symlinkWriteBlocked =
        symlinkResult.Stdout.Contains("runtime_symlink_created_write_blocked", StringComparison.Ordinal);
    Require(
        symlinkResult.ExitCode == 0 &&
        ((symlinkCreationBlocked && !symlinkCreated) || (symlinkWriteBlocked && symlinkCreated)),
        $"runtime_symlink_outcome_invalid:{symlinkResult.ExitCode}:{symlinkResult.Stdout}:{symlinkResult.Stderr}");
    Require(!File.Exists(symlinkEscape), "runtime_symlink_external_write_was_not_blocked");
    Console.WriteLine(symlinkCreated
        ? "runtime_symlink_created_write_blocked"
        : "runtime_symlink_creation_blocked");
    if (symlinkCreated) Directory.Delete(runtimeSymlink);

    var protectedRoot = Path.Combine(workspace, "protected");
    var protectedFile = Path.Combine(protectedRoot, "protected.txt");
    Directory.CreateDirectory(protectedRoot);
    File.WriteAllText(protectedFile, "protected-original");
    ConfigureProtectedBoundary(protectedRoot, writeCapabilitySid);
    var protectedResult = await RunAsync(
        Request("workspace-write", workspace, $"echo escaped>\"{protectedFile}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        protectedResult.ExitCode != 0 &&
        string.Equals(File.ReadAllText(protectedFile), "protected-original", StringComparison.Ordinal),
        "protected_subpath_write_was_not_blocked");

    var powerShellProbe = await RunAsync(
        Request(
            "workspace-write",
            workspace,
            "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Write-Output probe-ok\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        powerShellProbe.ExitCode == 0 && powerShellProbe.Stdout.Contains("probe-ok", StringComparison.Ordinal),
        $"powershell_probe_failed:{powerShellProbe.ExitCode}:{powerShellProbe.Stderr}");

    var worldWritableFile = Path.Combine(worldWritable, "world-escape.txt");
    var worldWritableResult = await RunAsync(
        Request("workspace-write", workspace, $"echo escaped>\"{worldWritableFile}\""),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        worldWritableResult.ExitCode != 0 &&
        !File.Exists(worldWritableFile) &&
        worldWritableResult.Isolation.PublicObjectWriteRestricted,
        "world_writable_escape_was_not_blocked");

    var desktopResult = await RunAsync(
        Request(
            "workspace-write",
            workspace,
            command: "",
            invocation: new InvocationRequest
            {
                Kind = "file",
                File = selfExecutable,
                Args = ["--probe-private-desktop"],
            }),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        desktopResult.ExitCode == 0 &&
        desktopResult.Stdout.Contains("private_desktop_isolation_ok", StringComparison.Ordinal),
        $"private_desktop_isolation_failed:{desktopResult.ExitCode}:{desktopResult.Stderr}");

    var readOnlyFile = Path.Combine(workspace, "read-only-write.txt");
    var readOnlyResult = await RunAsync(
        Request("read-only", workspace, $"echo escaped>\"{readOnlyFile}\""),
        currentSid,
        writeCapabilitySid,
        new SecurityIdentifier("S-1-5-12"));
    Require(readOnlyResult.ExitCode != 0 && !File.Exists(readOnlyFile), "read_only_write_was_not_blocked");

    var policyWorkspace = Path.Combine(root, "policy-workspace");
    var scopeId = "0123456789abcdef0123456789abcdef";
    var scopeRoot = Path.Combine(
        policyWorkspace,
        ".ariadne",
        "runtime",
        "subagent-workspaces",
        $"{scopeId}-smoke",
        "repository");
    Directory.CreateDirectory(policyWorkspace);
    ConfigureBoundary(
        policyWorkspace,
        usersSid,
        restrictedCapability: null,
        filesystemCapabilitySid);
    Directory.CreateDirectory(scopeRoot);
    var scopeAuthorization = EphemeralWriteScopeManager.Prepare(
        new WriteScopeRequest { ScopeId = scopeId, Root = scopeRoot },
        new DesiredPolicy(
            Path.Combine(root, "state"),
            policyWorkspace,
            [],
            [],
            [],
            "offline",
            "online",
            "writers",
            false,
            "digest"),
        new SetupManifest
        {
            Version = 2,
            PolicyDigest = "digest",
            OwnerSid = currentSid.Value,
            OfflineUser = "offline",
            OfflineUserSid = usersSid.Value,
            OnlineUser = "online",
            OnlineUserSid = usersSid.Value,
            WriterGroup = "writers",
            WriterGroupSid = usersSid.Value,
            FilesystemCapabilitySid = filesystemCapabilitySid.Value,
            FirewallRule = "smoke",
            WorkspaceRoot = policyWorkspace,
        },
        currentSid);
    var scopedFile = Path.Combine(scopeRoot, "scoped.txt");
    var scopedWrite = await RunAsync(
        Request(
            "workspace-write",
            scopeRoot,
            $"echo scoped-ok>\"{scopedFile}\"",
            policyRoot: policyWorkspace,
            writeScope: new WriteScopeRequest { ScopeId = scopeId, Root = scopeRoot }),
        currentSid,
        writeCapabilitySid,
        new SecurityIdentifier(scopeAuthorization.CapabilitySid));
    Require(scopedWrite.ExitCode == 0 && File.Exists(scopedFile), "ephemeral_scope_write_was_not_allowed");
    var primaryEscape = Path.Combine(policyWorkspace, "primary-escape.txt");
    var primaryWrite = await RunAsync(
        Request(
            "workspace-write",
            scopeRoot,
            $"echo escaped>\"{primaryEscape}\"",
            policyRoot: policyWorkspace,
            writeScope: new WriteScopeRequest { ScopeId = scopeId, Root = scopeRoot }),
        currentSid,
        writeCapabilitySid,
        new SecurityIdentifier(scopeAuthorization.CapabilitySid));
    Require(primaryWrite.ExitCode != 0 && !File.Exists(primaryEscape), "ephemeral_scope_primary_write_was_not_blocked");

    var outputRequest = Request(
        "workspace-write",
        workspace,
        "for /L %i in (1,1,1000) do @echo 1234567890",
        maxOutputBytes: 100);
    var outputResult = await RunAsync(outputRequest, currentSid, writeCapabilitySid, writeCapabilitySid);
    Require(outputResult.Truncated && Encoding.UTF8.GetByteCount(outputResult.Stdout) <= 100,
        "output_limit_was_not_enforced");

    var environmentRequest = Request(
        "workspace-write",
        workspace,
        "echo %ARIADNE_RESTRICTED_PROCESS%^|%USERPROFILE%",
        environment: new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["USERPROFILE"] = "C:\\must-not-be-used",
        });
    var environmentResult = await RunAsync(environmentRequest, currentSid, writeCapabilitySid, writeCapabilitySid);
    Require(environmentResult.Stdout.Contains("1|", StringComparison.Ordinal) &&
            !environmentResult.Stdout.Contains("must-not-be-used", StringComparison.OrdinalIgnoreCase),
        "sandbox_account_environment_was_not_restored");
    var invalidEnvironment = Request(
        "workspace-write",
        workspace,
        "exit /b 0",
        environment: new Dictionary<string, string> { ["ARIADNE_TEST_SECRET"] = "secret" });
    ExpectRequestFailure(invalidEnvironment);

    var handleProbePath = Path.Combine(root, "must-not-be-inherited.txt");
    File.WriteAllText(handleProbePath, "private parent handle");
    using (var inheritableHandle = File.OpenHandle(
               handleProbePath,
               FileMode.Open,
               FileAccess.Read,
               FileShare.Read | FileShare.Delete))
    {
        NativeHandleProbe.MarkInheritable(inheritableHandle);
        var handleProbeResult = await RunAsync(
            Request(
                "workspace-write",
                workspace,
                command: "",
                invocation: new InvocationRequest
                {
                    Kind = "file",
                    File = selfExecutable,
                    Args =
                    [
                        "--probe-inherited-file-handle",
                        inheritableHandle.DangerousGetHandle().ToInt64().ToString(),
                        handleProbePath,
                    ],
                }),
            currentSid,
            writeCapabilitySid,
            writeCapabilitySid);
        Require(
            handleProbeResult.ExitCode == 0,
            $"non_protocol_handle_was_inherited:exit={handleProbeResult.ExitCode}:" +
            $"stdout={handleProbeResult.Stdout}:stderr={handleProbeResult.Stderr}");
    }

    var timeoutRequest = Request(
        "workspace-write",
        workspace,
        "powershell.exe -NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 10\"",
        timeoutMs: 250);
    var timeoutResult = await RunAsync(timeoutRequest, currentSid, writeCapabilitySid, writeCapabilitySid);
    Require(
        timeoutResult.TimedOut,
        $"wall_timeout_was_not_enforced:exit={timeoutResult.ExitCode}:stderr={timeoutResult.Stderr}");

    var sentinel = Path.Combine(workspace, "descendant-escaped.txt");
    var treeCommand = $"start \"\" /b cmd.exe /d /s /c \"ping 127.0.0.1 -n 3 ^>nul ^& echo escaped^>\\\"{sentinel}\\\"\"";
    var treeResult = await RunAsync(
        Request("workspace-write", workspace, treeCommand),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(treeResult.ExitCode == 0, "tree_launcher_failed");
    await Task.Delay(3_000);
    Require(!File.Exists(sentinel), "residual_process_tree_survived_job_termination");

    var processLimitSentinel = Path.Combine(workspace, "process-limit-escaped.txt");
    var processLimitResult = await RunAsync(
        Request(
            "workspace-write",
            workspace,
            command: "",
            invocation: new InvocationRequest
            {
                Kind = "file",
                File = selfExecutable,
                Args = ["--probe-process-limit", processLimitSentinel],
            },
            resourceLimits: new ResourceLimits { MaxProcesses = 1 }),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        processLimitResult.ExitCode == 0 &&
        processLimitResult.Stdout.Contains("active_process_limit_blocked_descendant", StringComparison.Ordinal) &&
        !File.Exists(processLimitSentinel),
        $"active_process_limit_was_not_enforced:exit={processLimitResult.ExitCode}:" +
        $"stdout={processLimitResult.Stdout}:stderr={processLimitResult.Stderr}");

    var memoryLimitResult = await RunAsync(
        Request(
            "workspace-write",
            workspace,
            command: "",
            timeoutMs: 10_000,
            invocation: new InvocationRequest
            {
                Kind = "file",
                File = selfExecutable,
                Args = ["--probe-memory-limit"],
            },
            resourceLimits: new ResourceLimits
            {
                MaxProcesses = 1,
                MaxMemoryBytes = 128L * 1024 * 1024,
            }),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        memoryLimitResult.ExitCode != 0 && !memoryLimitResult.TimedOut,
        $"job_memory_limit_was_not_enforced:exit={memoryLimitResult.ExitCode}:" +
        $"timedOut={memoryLimitResult.TimedOut}:stderr={memoryLimitResult.Stderr}");

    var cpuLimitResult = await RunAsync(
        Request(
            "workspace-write",
            workspace,
            command: "",
            timeoutMs: 10_000,
            invocation: new InvocationRequest
            {
                Kind = "file",
                File = selfExecutable,
                Args = ["--probe-cpu-limit"],
            },
            resourceLimits: new ResourceLimits
            {
                MaxProcesses = 1,
                MaxCpuTimeMs = 250,
            }),
        currentSid,
        writeCapabilitySid,
        writeCapabilitySid);
    Require(
        cpuLimitResult.ExitCode != 0 && !cpuLimitResult.TimedOut,
        $"job_cpu_limit_was_not_enforced:exit={cpuLimitResult.ExitCode}:" +
        $"timedOut={cpuLimitResult.TimedOut}:stderr={cpuLimitResult.Stderr}");
    Console.WriteLine("resource_limits_smoke_ok");

    Console.WriteLine("restricted_runner_smoke_ok");
    return 0;
}
finally
{
    File.Delete(profileSentinel);
    if (Directory.Exists(runtimeJunction)) Directory.Delete(runtimeJunction);
    TryDeleteDirectoryLink(runtimeSymlink);
    new DirectoryInfo(root).SetAccessControl(rootSecurity);
    Directory.Delete(root, recursive: true);
}

static ExecutionRequest Request(
    string mode,
    string workspace,
    string command,
    int timeoutMs = 5_000,
    int maxOutputBytes = 1024 * 1024,
    Dictionary<string, string>? environment = null,
    InvocationRequest? invocation = null,
    string? policyRoot = null,
    WriteScopeRequest? writeScope = null,
    string? stdinBase64 = null,
    ResourceLimits? resourceLimits = null) => new()
{
    ExecutionId = Guid.NewGuid().ToString("N"),
    Invocation = invocation ?? new InvocationRequest { Kind = "shell", Command = command },
    Cwd = workspace,
    WorkspaceRoot = policyRoot ?? workspace,
    WriteScope = writeScope,
    Mode = mode,
    NetworkMode = "online-approved",
    Environment = environment ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
    TimeoutMs = timeoutMs,
    MaxOutputBytes = maxOutputBytes,
    StdinBase64 = stdinBase64,
    ResourceLimits = resourceLimits ?? new ResourceLimits { MaxProcesses = 8 },
};

async Task<NativeExecutionResult> RunAsync(
    ExecutionRequest request,
    SecurityIdentifier currentSid,
    SecurityIdentifier writerSid,
    SecurityIdentifier restrictionSid)
{
    ExecutionValidator.Validate(request);
    var sink = new CapturingSink();
    var result = await RestrictedCommandRunner.ExecuteAsync(
        request,
        new RunnerIdentity(
            currentSid.Value,
            writerSid.Value,
            restrictionSid.Value,
            filesystemCapabilitySid.Value,
            RequireWriterMembership: false),
        sink);
    Require(sink.StartedCount == 1 && sink.ResultCount == 1, "runner_protocol_terminal_count_invalid");
    Require(sink.OutputBytes <= request.MaxOutputBytes, "runner_protocol_output_limit_invalid");
    return result;
}

static async Task<int> RunInsideSupervisorJobAsync(
    IReadOnlyCollection<string> forwardedArgs,
    string supervisedMarker)
{
    var executable = Environment.ProcessPath;
    if (string.IsNullOrWhiteSpace(executable) || !File.Exists(executable))
    {
        throw new InvalidOperationException("runner_smoke_apphost_missing");
    }
    using var job = WindowsJobObject.CreateSupervisor();
    using var inputPipe = WindowsChildPipe.CreateForChildInput();
    using var outputPipe = WindowsChildPipe.CreateForChildOutput();
    using var errorPipe = WindowsChildPipe.CreateForChildOutput();
    using var inputStream = inputPipe.OpenParentStream(FileAccess.Write);
    using var outputStream = outputPipe.OpenParentStream(FileAccess.Read);
    using var errorStream = errorPipe.OpenParentStream(FileAccess.Read);

    var commandLine = string.Join(' ', new[]
    {
        WindowsCommandLine.QuoteArgument(executable),
        WindowsCommandLine.QuoteArgument(supervisedMarker),
    }.Concat(forwardedArgs.Select(WindowsCommandLine.QuoteArgument)));
    WindowsProcessHandles? child = null;
    try
    {
        child = SmokeSupervisorProcessLauncher.Start(
            job,
            executable,
            commandLine,
            Environment.CurrentDirectory,
            inputPipe.ChildEnd,
            outputPipe.ChildEnd,
            errorPipe.ChildEnd);
    }
    finally
    {
        inputPipe.CloseChildEnd();
        outputPipe.CloseChildEnd();
        errorPipe.CloseChildEnd();
    }

    using (child)
    {
        inputStream.Dispose();
        var stdout = outputStream.CopyToAsync(Console.OpenStandardOutput());
        var stderr = errorStream.CopyToAsync(Console.OpenStandardError());
        if (!await Task.Run(() => child.Wait(180_000)))
        {
            job.Terminate(124);
            if (!child.Wait(10_000))
            {
                throw new InvalidOperationException("supervised_runner_smoke_did_not_terminate");
            }
            throw new InvalidOperationException("supervised_runner_smoke_timed_out");
        }
        await Task.WhenAll(stdout, stderr);
        return child.ExitCode();
    }
}

static void ConfigureBoundary(
    string path,
    SecurityIdentifier normalAccessSid,
    SecurityIdentifier? restrictedCapability,
    SecurityIdentifier? filesystemCapability = null)
{
    var security = new DirectorySecurity();
    security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
    security.AddAccessRule(new FileSystemAccessRule(
        normalAccessSid,
        FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
        PropagationFlags.None,
        AccessControlType.Allow));
    if (restrictedCapability is not null)
    {
        security.AddAccessRule(new FileSystemAccessRule(
            restrictedCapability,
            FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
    }
    if (filesystemCapability is not null)
    {
        security.AddAccessRule(new FileSystemAccessRule(
            filesystemCapability,
            FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
    }
    new DirectoryInfo(path).SetAccessControl(security);
}

static void ConfigureProtectedBoundary(string path, SecurityIdentifier writerSid)
{
    var security = new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access);
    security.AddAccessRule(new FileSystemAccessRule(
        writerSid,
        FileSystemRights.Modify,
        InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
        PropagationFlags.None,
        AccessControlType.Deny));
    new DirectoryInfo(path).SetAccessControl(security);
}

static void ExpectRequestFailure(
    ExecutionRequest request,
    string failureCode = "disallowed_environment_was_accepted")
{
    try
    {
        ExecutionValidator.Validate(request);
    }
    catch (RequestException)
    {
        return;
    }
    throw new InvalidOperationException(failureCode);
}

static void TryDeleteDirectoryLink(string path)
{
    try
    {
        Directory.Delete(path);
    }
    catch (DirectoryNotFoundException)
    {
    }
}

static void VerifyGroupMemberPagination()
{
    var calls = 0;
    var members = WindowsAccountManager.CollectMembers(resumeHandle =>
    {
        calls++;
        return calls switch
        {
            1 when resumeHandle == UIntPtr.Zero => new LocalGroupMemberPage(
                234,
                new UIntPtr(7),
                ["TEST\\first"],
                2),
            2 when resumeHandle == new UIntPtr(7) => new LocalGroupMemberPage(
                0,
                new UIntPtr(7),
                ["TEST\\second"],
                1),
            _ => throw new InvalidOperationException("group_member_pagination_resume_invalid"),
        };
    });
    Require(
        calls == 2 && members.SetEquals(["TEST\\first", "TEST\\second"]),
        "group_member_pagination_dropped_members");

    ExpectGroupMemberPaginationFailure(
        "managed_group_members_pagination_stalled",
        _ => new LocalGroupMemberPage(
            234,
            UIntPtr.Zero,
            ["TEST\\stalled"],
            2));
    ExpectGroupMemberPaginationFailure(
        "managed_group_members_pagination_stalled",
        _ => new LocalGroupMemberPage(234, new UIntPtr(7), [], 2));
    ExpectGroupMemberPaginationFailure(
        "managed_group_members_pagination_stalled",
        _ => new LocalGroupMemberPage(234, new UIntPtr(7), ["TEST\\repeated"], 2));
    ExpectGroupMemberPaginationFailure(
        "managed_group_members_limit_exceeded",
        _ => new LocalGroupMemberPage(0, UIntPtr.Zero, [], 65_537));
    Console.WriteLine("group_member_pagination_contract_ok");
}

static void ExpectGroupMemberPaginationFailure(
    string expectedCode,
    Func<UIntPtr, LocalGroupMemberPage> readPage)
{
    try
    {
        _ = WindowsAccountManager.CollectMembers(readPage);
    }
    catch (SetupException error) when (error.Code == expectedCode)
    {
        return;
    }
    throw new InvalidOperationException($"group_member_pagination_failure_missing:{expectedCode}");
}

static void VerifyElevationRequestContract()
{
    var root = Path.Combine(Path.GetTempPath(), $"ariadne-elevation-request-smoke-{Guid.NewGuid():N}");
    Directory.CreateDirectory(root);
    try
    {
        var requestPath = Path.Combine(root, "request.json");
        const string requestJson = "{\"stateRoot\":\"C:\\\\ProgramData\\\\Ariadne\\\\sandbox\"}";
        File.WriteAllText(requestPath, requestJson);
        var canonicalPath = WindowsPathResolver.Canonicalize(requestPath);
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(requestJson)));
        Require(
            string.Equals(
                SetupElevation.ReadVerifiedRequest(canonicalPath, digest),
                requestJson,
                StringComparison.Ordinal),
            "elevation_request_content_changed");

        ExpectElevationRequestFailure(
            "elevation_request_digest_mismatch",
            () => SetupElevation.ReadVerifiedRequest(canonicalPath, new string('0', 64)));
        ExpectElevationRequestFailure(
            "elevation_request_identity_changed",
            () => SetupElevation.ReadVerifiedRequest(Path.Combine(root, ".", "request.json"), digest));

        File.WriteAllText(requestPath, string.Empty);
        ExpectElevationRequestFailure(
            "elevation_request_invalid",
            () => SetupElevation.ReadVerifiedRequest(canonicalPath, digest));

        File.WriteAllBytes(requestPath, new byte[(1024 * 1024) + 1]);
        ExpectElevationRequestFailure(
            "elevation_request_invalid",
            () => SetupElevation.ReadVerifiedRequest(canonicalPath, digest));
        Console.WriteLine("elevation_request_contract_ok");
    }
    finally
    {
        Directory.Delete(root, true);
    }
}

static void ExpectElevationRequestFailure(string expectedCode, Action read)
{
    try
    {
        read();
    }
    catch (SetupException error) when (error.Code == expectedCode)
    {
        return;
    }
    throw new InvalidOperationException($"elevation_request_failure_missing:{expectedCode}");
}

static void VerifyCredentialBufferZeroing()
{
    const int size = 8193;
    var buffer = Marshal.AllocHGlobal(size);
    try
    {
        Marshal.Copy(Enumerable.Repeat((byte)0xA5, size).ToArray(), 0, buffer, size);
        CredentialVault.ZeroUnmanagedBuffer(buffer, size);
        var cleared = new byte[size];
        Marshal.Copy(buffer, cleared, 0, cleared.Length);
        Require(cleared.All(value => value == 0), "credential_native_buffer_not_zeroed");
    }
    finally
    {
        Marshal.FreeHGlobal(buffer);
    }
    Console.WriteLine("credential_buffer_zeroing_contract_ok");
}

static void VerifyOneShotExecutionCredential()
{
    const string secret = "one-shot-secret";
    var authorization = new ExecutionAuthorization(
        null!,
        null!,
        "account",
        "S-1-5-21-1-2-3-4",
        secret,
        "S-1-5-12",
        null);
    Require(!authorization.ToString()!.Contains(secret, StringComparison.Ordinal), "credential_tostring_leaked_secret");
    Require(
        authorization.UsePasswordOnce(password => string.Equals(password, secret, StringComparison.Ordinal)),
        "credential_first_consumption_failed");
    ExpectCredentialConsumed(authorization);

    var failedAuthorization = new ExecutionAuthorization(
        null!,
        null!,
        "account",
        "S-1-5-21-1-2-3-4",
        secret,
        "S-1-5-12",
        null);
    try
    {
        _ = failedAuthorization.UsePasswordOnce<bool>(_ => throw new InvalidOperationException("expected_callback_failure"));
    }
    catch (InvalidOperationException error) when (error.Message == "expected_callback_failure")
    {
    }
    ExpectCredentialConsumed(failedAuthorization);
    Console.WriteLine("one_shot_execution_credential_contract_ok");
}

static void VerifySandboxArtifactLeaseJournalContract()
{
    var lease = new SandboxArtifactLease
    {
        ExecutionId = "lease-contract",
        AccountSid = "S-1-5-21-1-2-3-1001",
        TempRoot = PathPolicy.NormalizeAbsolute(Path.GetTempPath(), "test.tempRoot"),
        FilesystemCapabilitySid = "S-1-15-3-2",
        PolicyDigest = new string('a', 64),
    };
    SandboxArtifactLeaseStore.ValidateJournalForTest(new SandboxArtifactLeaseJournal
    {
        Version = 1,
        Leases = [lease],
    });
    ExpectArtifactLeaseFailure(new SandboxArtifactLeaseJournal
    {
        Version = 1,
        Leases = [lease, lease],
    });
    ExpectArtifactLeaseFailure(new SandboxArtifactLeaseJournal
    {
        Version = 1,
        Leases = [null!],
    });
    ExpectArtifactLeaseFailure(new SandboxArtifactLeaseJournal
    {
        Version = 1,
        Leases =
        [
            new SandboxArtifactLease
            {
                ExecutionId = "lease-invalid",
                AccountSid = "not-a-sid",
                TempRoot = "relative",
                FilesystemCapabilitySid = "not-a-capability",
                PolicyDigest = "invalid",
            },
        ],
    });
    Console.WriteLine("sandbox_artifact_lease_contract_ok");
}

static void ExpectArtifactLeaseFailure(SandboxArtifactLeaseJournal journal)
{
    try
    {
        SandboxArtifactLeaseStore.ValidateJournalForTest(journal);
    }
    catch (NativeExecutionException error) when (error.Code == "sandbox_cleanup_failure")
    {
        return;
    }
    throw new InvalidOperationException("sandbox_artifact_lease_invalid_record_accepted");
}

static void ExpectCredentialConsumed(ExecutionAuthorization authorization)
{
    try
    {
        _ = authorization.UsePasswordOnce(_ => true);
    }
    catch (NativeExecutionException error) when (error.Code == "credential_failure")
    {
        return;
    }
    throw new InvalidOperationException("execution_credential_was_reusable");
}

static void VerifyAccountVisibilityContract()
{
    Require(WindowsAccountVisibility.IsHiddenRegistryValue(0), "account_visibility_zero_dword_rejected");
    Require(!WindowsAccountVisibility.IsHiddenRegistryValue(1), "account_visibility_enabled_value_accepted");
    Require(!WindowsAccountVisibility.IsHiddenRegistryValue(0L), "account_visibility_non_dword_accepted");
    Require(!WindowsAccountVisibility.IsHiddenRegistryValue(null), "account_visibility_missing_value_accepted");
    Console.WriteLine("account_visibility_contract_ok");
}

static void VerifyAccountLogonPolicyContract()
{
    Require(
        WindowsAccountLogonPolicy.HasRequiredRights([
            WindowsAccountLogonPolicy.DenyRemoteInteractiveLogonRight,
            WindowsAccountLogonPolicy.BatchLogonRight,
            WindowsAccountLogonPolicy.DenyInteractiveLogonRight,
            "SeChangeNotifyPrivilege",
        ]),
        "account_logon_policy_required_rights_rejected");
    Require(
        !WindowsAccountLogonPolicy.HasRequiredRights([
            WindowsAccountLogonPolicy.BatchLogonRight,
            WindowsAccountLogonPolicy.DenyRemoteInteractiveLogonRight,
        ]),
        "account_logon_policy_missing_local_deny_accepted");
    Console.WriteLine("account_logon_policy_contract_ok");
}

static void VerifyBrokerIdentityContract()
{
    var root = Path.Combine(Path.GetTempPath(), "Ariadne-Broker-Identity");
    var first = WindowsSandboxBrokerProtocol.PipeName(root);
    var second = WindowsSandboxBrokerProtocol.PipeName(root.ToUpperInvariant());
    var other = WindowsSandboxBrokerProtocol.PipeName(root + "-other");
    Require(string.Equals(first, second, StringComparison.Ordinal), "broker_pipe_case_identity_drifted");
    Require(!string.Equals(first, other, StringComparison.Ordinal), "broker_pipe_state_identity_collided");
    Require(first.StartsWith("Ariadne.WindowsSandbox.", StringComparison.Ordinal), "broker_pipe_prefix_invalid");
    Console.WriteLine("broker_identity_contract_ok");
}

static void VerifyBrokerServiceConfigurationContract()
{
    var executable = @"C:\Program Files\Ariadne\Ariadne.WindowsSandbox.exe";
    var stateRoot = @"C:\ProgramData\Ariadne\sandbox";
    var ownerSid = "S-1-5-21-1000-1001-1002-1003";
    var expectedBinaryPath = WindowsSandboxBrokerServicePolicy.BuildBinaryPath(
        executable,
        stateRoot,
        ownerSid);
    var valid = new BrokerServiceConfigurationSnapshot(
        WindowsSandboxBrokerServicePolicy.ServiceWin32OwnProcess,
        WindowsSandboxBrokerServicePolicy.ServiceAutoStart,
        WindowsSandboxBrokerServicePolicy.ServiceErrorNormal,
        expectedBinaryPath,
        "",
        0,
        [],
        "LocalSystem",
        WindowsSandboxBrokerServicePolicy.DisplayName,
        [.. WindowsSandboxBrokerServicePolicy.RequiredPrivileges]);

    Require(
        WindowsSandboxBrokerServicePolicy.Matches(valid, expectedBinaryPath),
        "broker_service_valid_configuration_rejected");
    Require(
        WindowsSandboxBrokerServicePolicy.Matches(
            valid with { ServiceStartName = @"NT AUTHORITY\LocalSystem" },
            expectedBinaryPath),
        "broker_service_local_system_sid_alias_rejected");
    foreach (var drifted in new[]
    {
        valid with { ServiceType = 0x00000020 },
        valid with { StartType = 3 },
        valid with { ErrorControl = 0 },
        valid with { BinaryPath = expectedBinaryPath + " --unexpected" },
        valid with { LoadOrderGroup = "Network" },
        valid with { TagId = 1 },
        valid with { Dependencies = ["RpcSs"] },
        valid with { ServiceStartName = @".\Administrator" },
        valid with { DisplayName = "Unexpected Broker" },
        valid with { RequiredPrivileges = [.. WindowsSandboxBrokerServicePolicy.RequiredPrivileges[..2]] },
        valid with { RequiredPrivileges = [.. WindowsSandboxBrokerServicePolicy.RequiredPrivileges, "SeDebugPrivilege"] },
        valid with { RequiredPrivileges = [.. WindowsSandboxBrokerServicePolicy.RequiredPrivileges, "SeImpersonatePrivilege"] },
    })
    {
        Require(
            !WindowsSandboxBrokerServicePolicy.Matches(drifted, expectedBinaryPath),
            "broker_service_configuration_drift_accepted");
    }
    Console.WriteLine("broker_service_configuration_contract_ok");
}

static async Task VerifyBrokerPipeContractAsync()
{
    Require(
        (WindowsSandboxBrokerProtocol.ClientConnectionRights &
         System.IO.Pipes.PipeAccessRights.CreateNewInstance) == 0,
        "broker_pipe_client_can_create_server_instance");
    Require(
        (WindowsSandboxBrokerProtocol.ClientConnectionRights &
         System.IO.Pipes.PipeAccessRights.ReadWrite) ==
        System.IO.Pipes.PipeAccessRights.ReadWrite,
        "broker_pipe_client_io_rights_missing");
    using var identity = WindowsIdentity.GetCurrent();
    var ownerSid = identity.User ?? throw new InvalidOperationException("broker_pipe_owner_sid_missing");
    var stateRoot = Path.Combine(Path.GetTempPath(), $"Ariadne-Broker-Pipe-{Guid.NewGuid():N}");
    using var server = WindowsSandboxBrokerProtocol.CreateServer(stateRoot, ownerSid);
    using var client = new System.IO.Pipes.NamedPipeClientStream(
        ".",
        WindowsSandboxBrokerProtocol.PipeName(stateRoot),
        System.IO.Pipes.PipeDirection.InOut,
        System.IO.Pipes.PipeOptions.Asynchronous,
        TokenImpersonationLevel.Impersonation);
    var accept = server.WaitForConnectionAsync();
    await client.ConnectAsync(5_000);
    await accept;
    string? clientSid = null;
    server.RunAsClient(() =>
    {
        using var clientIdentity = WindowsIdentity.GetCurrent(TokenAccessLevels.Query);
        clientSid = clientIdentity.User?.Value;
    });
    Require(string.Equals(clientSid, ownerSid.Value, StringComparison.Ordinal), "broker_pipe_impersonation_mismatch");
    await client.WriteAsync("x"u8.ToArray());
    await client.FlushAsync();
    var probe = new byte[1];
    Require(await server.ReadAsync(probe) == 1 && probe[0] == (byte)'x', "broker_pipe_duplex_failed");
    Console.WriteLine("broker_pipe_contract_ok");
}

static void VerifyExecutionInputProtocolContract()
{
    var workspace = Path.GetTempPath();
    var maximumInput = Convert.ToBase64String(new byte[ExecutionValidator.MaxStdinBytes]);
    ExecutionValidator.Validate(Request(
        "read-only",
        workspace,
        "echo accepted",
        stdinBase64: maximumInput));

    ExpectRequestFailure(
        Request(
            "read-only",
            workspace,
            "echo rejected",
            stdinBase64: Convert.ToBase64String(new byte[ExecutionValidator.MaxStdinBytes + 1])),
        "oversized_stdin_was_accepted");
    ExpectRequestFailure(
        Request("read-only", workspace, "echo rejected", stdinBase64: "YQ==\r\n"),
        "noncanonical_stdin_was_accepted");
    var excessiveToolRoots = Request("read-only", workspace, "echo rejected");
    excessiveToolRoots.ToolReadRoots.AddRange(
        Enumerable.Range(0, 65).Select(index => Path.Combine(workspace, $"tool-{index}")));
    ExpectRequestFailure(excessiveToolRoots, "excessive_tool_read_roots_were_accepted");

    _ = WindowsSandboxBrokerProtocol.SerializeRequest(
        Request("read-only", workspace, "echo accepted"));
    try
    {
        _ = WindowsSandboxBrokerProtocol.SerializeRequest(Request(
            "read-only",
            workspace,
            new string('x', WindowsSandboxBrokerProtocol.MaxRequestBytes)));
        throw new InvalidOperationException("oversized_broker_request_was_accepted");
    }
    catch (NativeExecutionException error) when (error.Code == "invalid_request")
    {
    }

    Console.WriteLine("execution_input_protocol_contract_ok");
}

static void Require(bool condition, string code)
{
    if (!condition) throw new InvalidOperationException(code);
}

internal sealed class CapturingSink : INativeExecutionEventSink
{
    internal int StartedCount { get; private set; }
    internal int ResultCount { get; private set; }
    internal int OutputBytes { get; private set; }

    public void Started(string executionId, int pid, NativeIsolation isolation) => StartedCount++;

    public void Output(string executionId, bool isError, byte[] data) => OutputBytes += data.Length;

    public void Result(string executionId, NativeExecutionResult result) => ResultCount++;
}

internal static class NativeHandleProbe
{
    private const uint HandleFlagInherit = 0x00000001;
    private const uint FileTypeDisk = 0x00000001;

    internal static bool IsDiskFile(SafeFileHandle handle) => GetFileType(handle) == FileTypeDisk;

    internal static void MarkInheritable(SafeFileHandle handle)
    {
        if (!SetHandleInformation(handle, HandleFlagInherit, HandleFlagInherit))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }

    [DllImport("Kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        SafeFileHandle handle,
        uint mask,
        uint flags);

    [DllImport("Kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);
}

internal static class WindowsShortPathProbe
{
    internal static string Resolve(string path)
    {
        var capacity = 512;
        for (var attempt = 0; attempt < 4; attempt++)
        {
            var buffer = new StringBuilder(capacity);
            var length = GetShortPathName(path, buffer, (uint)buffer.Capacity);
            if (length == 0)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "runtime_8dot3_alias_resolution_failed");
            }
            if (length < buffer.Capacity) return buffer.ToString();
            capacity = checked((int)length + 1);
        }
        throw new InvalidOperationException("runtime_8dot3_alias_exceeds_limit");
    }

    [DllImport("Kernel32.dll", EntryPoint = "GetShortPathNameW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetShortPathName(
        string longPath,
        StringBuilder shortPath,
        uint shortPathSize);
}

internal static class RuntimeSymlinkProbe
{
    private const uint SymbolicLinkFlagDirectory = 0x00000001;
    private const uint SymbolicLinkFlagAllowUnprivilegedCreate = 0x00000002;
    private const uint FileAttributeReparsePoint = 0x00000400;
    private const uint InvalidFileAttributes = 0xFFFFFFFF;
    private const int ErrorPathNotFound = 3;
    private const int ErrorAccessDenied = 5;
    private const int ErrorPrivilegeNotHeld = 1314;

    internal static int Run(string linkPath, string targetPath, string linkedFilePath)
    {
        if (!CreateSymbolicLink(
                linkPath,
                targetPath,
                SymbolicLinkFlagDirectory | SymbolicLinkFlagAllowUnprivilegedCreate))
        {
            var error = Marshal.GetLastWin32Error();
            if (error is ErrorAccessDenied or ErrorPrivilegeNotHeld)
            {
                Console.WriteLine($"runtime_symlink_creation_blocked:{error}");
                return 0;
            }
            throw new Win32Exception(error, "runtime_symlink_creation_failed_unexpectedly");
        }

        var attributes = GetFileAttributes(linkPath);
        if (attributes == InvalidFileAttributes || (attributes & FileAttributeReparsePoint) == 0)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "runtime_symlink_reparse_identity_missing");
        }
        Console.WriteLine("runtime_symlink_reparse_created");

        try
        {
            File.WriteAllText(linkedFilePath, "escaped");
            Console.Error.WriteLine("runtime_symlink_external_write_succeeded");
            return 95;
        }
        catch (Exception error) when (
            error is UnauthorizedAccessException ||
            error is IOException &&
            (error.HResult & 0xFFFF) is ErrorPathNotFound or ErrorAccessDenied)
        {
            Console.WriteLine("runtime_symlink_created_write_blocked");
            return 0;
        }
    }

    [DllImport("Kernel32.dll", EntryPoint = "CreateSymbolicLinkW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.I1)]
    private static extern bool CreateSymbolicLink(
        string symlinkFileName,
        string targetFileName,
        uint flags);

    [DllImport("Kernel32.dll", EntryPoint = "GetFileAttributesW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern uint GetFileAttributes(string fileName);
}

internal static class DesktopIsolationProbe
{
    private const int UoiName = 2;
    private const uint DesktopSwitchDesktop = 0x0100;

    internal static int Run()
    {
        var current = GetThreadDesktop(GetCurrentThreadId());
        var name = UserObjectName(current);
        if (!name.StartsWith("AriadneDesktop-", StringComparison.Ordinal)) return 92;

        var input = OpenInputDesktop(0, false, DesktopSwitchDesktop);
        if (input != IntPtr.Zero)
        {
            var escaped = SwitchDesktop(input);
            _ = CloseDesktop(input);
            if (escaped) return 93;
        }
        var defaultDesktop = OpenDesktop("Default", 0, false, DesktopSwitchDesktop);
        if (defaultDesktop != IntPtr.Zero)
        {
            var escaped = SwitchDesktop(defaultDesktop);
            _ = CloseDesktop(defaultDesktop);
            if (escaped) return 94;
        }

        Console.WriteLine("private_desktop_isolation_ok");
        return 0;
    }

    private static string UserObjectName(IntPtr handle)
    {
        _ = GetUserObjectInformation(handle, UoiName, null, 0, out var required);
        if (required <= 2) return "";
        var buffer = new StringBuilder(checked((int)(required / sizeof(char))));
        return GetUserObjectInformation(handle, UoiName, buffer, required, out _)
            ? buffer.ToString()
            : "";
    }

    [DllImport("Kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("User32.dll")]
    private static extern IntPtr GetThreadDesktop(uint threadId);

    [DllImport("User32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SwitchDesktop(IntPtr desktop);

    [DllImport("User32.dll", EntryPoint = "GetUserObjectInformationW", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(
        IntPtr handle,
        int index,
        StringBuilder? information,
        uint length,
        out uint needed);

    [DllImport("User32.dll", EntryPoint = "OpenInputDesktop", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(
        uint flags,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint desiredAccess);

    [DllImport("User32.dll", EntryPoint = "OpenDesktopW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenDesktop(
        string desktop,
        uint flags,
        [MarshalAs(UnmanagedType.Bool)] bool inherit,
        uint desiredAccess);

    [DllImport("User32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(IntPtr desktop);
}
