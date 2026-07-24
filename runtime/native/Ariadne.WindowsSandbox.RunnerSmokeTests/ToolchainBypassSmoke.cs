using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Ariadne.WindowsSandbox;

internal static class ToolchainBypassSmoke
{
    private static readonly SecurityIdentifier RestrictedCodeSid = new("S-1-5-12");

    internal static async Task RunAsync(
        string gitPath,
        string pythonPath,
        string npmPath,
        string nodePath)
    {
        var tools = new ToolchainPaths(
            RequireTool(gitPath, "git"),
            RequireTool(pythonPath, "python"),
            RequireTool(npmPath, "npm"),
            RequireTool(nodePath, "node"));
        using var identity = WindowsIdentity.GetCurrent();
        if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator))
        {
            throw new InvalidOperationException("toolchain_bypass_smoke_requires_standard_user_token");
        }
        var currentSid = identity.User
            ?? throw new InvalidOperationException("current_user_sid_missing");
        var usersSid = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        var writeCapabilitySid = new SecurityIdentifier("S-1-5-21-999999981-999999982-999999983-1902");
        var filesystemCapabilitySid = WindowsAppContainerProfile.DeriveCapabilitySid(
            $"Ariadne.toolchain-smoke.{Guid.NewGuid():N}");
        var root = Path.Combine(Path.GetTempPath(), $"ariadne-toolchain-smoke-{Guid.NewGuid():N}");
        var workspace = Path.Combine(root, "workspace");
        var external = Path.Combine(root, "external");
        Directory.CreateDirectory(workspace);
        Directory.CreateDirectory(external);
        var rootSecurity = new DirectoryInfo(root).GetAccessControl(AccessControlSections.Access);

        Exception? failure = null;
        try
        {
            var fixtures = PrepareFixtures(tools, workspace, external);
            ConfigureBoundary(workspace, usersSid, writeCapabilitySid, filesystemCapabilitySid);
            ConfigureBoundary(external, usersSid, restrictedCapability: null);

            await VerifyPythonAsync(tools.Python, fixtures, currentSid, writeCapabilitySid, filesystemCapabilitySid);
            await VerifyNpmAsync(tools, fixtures, currentSid, writeCapabilitySid, filesystemCapabilitySid);
            await VerifyGitAsync(tools.Git, fixtures, currentSid, writeCapabilitySid, filesystemCapabilitySid);
        }
        catch (Exception error)
        {
            failure = error;
        }
        finally
        {
            try
            {
                RestoreForCleanup(root, rootSecurity);
            }
            catch when (failure is not null)
            {
            }
        }
        if (failure is not null) throw failure;
    }

    private static ToolchainFixtures PrepareFixtures(
        ToolchainPaths tools,
        string workspace,
        string external)
    {
        var gitWrite = PrepareGitRepository(
            tools,
            Path.Combine(workspace, "git-write"),
            Path.Combine(external, "git-escape.txt"),
            "git-hook-workspace.txt");
        var gitReadOnly = PrepareGitRepository(
            tools,
            Path.Combine(workspace, "git-read-only"),
            Path.Combine(external, "git-read-only-escape.txt"),
            "git-read-only-hook.txt");

        var pythonRoot = Path.Combine(workspace, "python");
        Directory.CreateDirectory(pythonRoot);
        var pythonScript = Path.Combine(pythonRoot, "probe.py");
        File.WriteAllText(
            pythonScript,
            """
            import os
            import pathlib
            import subprocess
            import sys

            mode = sys.argv[1]
            target = pathlib.Path(sys.argv[2])
            external = pathlib.Path(sys.argv[3])
            nested = pathlib.Path(sys.argv[4])

            if mode == "deny":
                try:
                    target.write_text("escaped", encoding="utf-8")
                except OSError:
                    raise SystemExit(0)
                raise SystemExit(91)

            target.write_text("python-ok", encoding="utf-8")
            try:
                external.write_text("escaped", encoding="utf-8")
            except OSError:
                pass
            else:
                raise SystemExit(92)

            command = f'echo nested-ok>"{nested}"'
            completed = subprocess.run(command, shell=True, check=False)
            raise SystemExit(0 if completed.returncode == 0 else 93)
            """,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        var npmRoot = Path.Combine(workspace, "npm");
        Directory.CreateDirectory(npmRoot);
        var npmScript = Path.Combine(npmRoot, "probe.cjs");
        var npmWorkspaceMarker = Path.Combine(npmRoot, "npm-workspace.txt");
        var npmReadOnlyMarker = Path.Combine(npmRoot, "npm-read-only.txt");
        var npmExternalMarker = Path.Combine(external, "npm-escape.txt");
        var npmResidualMarker = Path.Combine(workspace, "npm-residual-descendant.txt");
        File.WriteAllText(
            npmScript,
            $$"""
            const fs = require("node:fs");
            const path = require("node:path");
            const { spawn } = require("node:child_process");

            const mode = process.argv[2];
            const expectedNode = {{JsonSerializer.Serialize(tools.Node)}};
            const workspaceMarker = {{JsonSerializer.Serialize(npmWorkspaceMarker)}};
            const readOnlyMarker = {{JsonSerializer.Serialize(npmReadOnlyMarker)}};
            const externalMarker = {{JsonSerializer.Serialize(npmExternalMarker)}};
            const residualMarker = {{JsonSerializer.Serialize(npmResidualMarker)}};

            if (path.resolve(process.execPath).toLowerCase() !== path.resolve(expectedNode).toLowerCase()) process.exit(93);
            if (process.env.NODE_OPTIONS || process.env.NODE_PATH) process.exit(94);
            if (mode === "deny") {
              try {
                fs.writeFileSync(readOnlyMarker, "escaped", "utf8");
              } catch (error) {
                if (error && (error.code === "EACCES" || error.code === "EPERM")) process.exit(0);
                throw error;
              }
              process.exit(95);
            }

            fs.writeFileSync(workspaceMarker, "npm-ok", "utf8");
            try {
              fs.writeFileSync(externalMarker, "escaped", "utf8");
              process.exit(96);
            } catch (error) {
              if (!error || (error.code !== "EACCES" && error.code !== "EPERM")) throw error;
            }
            const child = spawn(
              process.env.COMSPEC,
              ["/d", "/s", "/c", `ping 127.0.0.1 -n 3 >nul & echo escaped>"${residualMarker}"`],
              { detached: true, stdio: "ignore", windowsHide: true },
            );
            child.unref();
            """,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        var scripts = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["sandbox-write"] = $"node {QuoteCmd(npmScript)} write",
            ["sandbox-read-only"] = $"node {QuoteCmd(npmScript)} deny",
        };
        File.WriteAllText(
            Path.Combine(npmRoot, "package.json"),
            JsonSerializer.Serialize(
                new Dictionary<string, object>
                {
                    ["name"] = "ariadne-sandbox-smoke",
                    ["version"] = "1.0.0",
                    ["private"] = true,
                    ["scripts"] = scripts,
                },
                new JsonSerializerOptions { WriteIndented = true }),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        return new ToolchainFixtures(
            workspace,
            external,
            gitWrite,
            gitReadOnly,
            pythonScript,
            Path.Combine(pythonRoot, "python-workspace.txt"),
            Path.Combine(pythonRoot, "python-nested-cmd.txt"),
            Path.Combine(pythonRoot, "python-read-only.txt"),
            Path.Combine(external, "python-escape.txt"),
            npmRoot,
            npmWorkspaceMarker,
            npmReadOnlyMarker,
            npmExternalMarker,
            npmResidualMarker);
    }

    private static GitFixture PrepareGitRepository(
        ToolchainPaths tools,
        string repository,
        string externalMarker,
        string markerName)
    {
        Directory.CreateDirectory(repository);
        RunHost(tools.Git, ["init", "--quiet", repository]);
        File.WriteAllText(Path.Combine(repository, "tracked.txt"), "tracked\n", Encoding.UTF8);
        RunHost(tools.Git, ["-C", repository, "add", "--", "tracked.txt"]);
        var workspaceMarker = Path.Combine(repository, markerName);
        var probe = Path.Combine(repository, "git-hook-probe.cjs");
        File.WriteAllText(
            probe,
            $$"""
            const fs = require("node:fs");
            const workspaceMarker = {{JsonSerializer.Serialize(workspaceMarker)}};
            const externalMarker = {{JsonSerializer.Serialize(externalMarker)}};
            fs.writeFileSync(workspaceMarker, "git-ok", "utf8");
            try {
              fs.writeFileSync(externalMarker, "escaped", "utf8");
              process.exit(97);
            } catch (error) {
              if (!error || (error.code !== "EACCES" && error.code !== "EPERM")) throw error;
            }
            """,
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        var hook = Path.Combine(repository, ".git", "hooks", "pre-commit");
        Directory.CreateDirectory(Path.GetDirectoryName(hook)!);
        File.WriteAllText(
            hook,
            $"#!/bin/sh\nexec {QuoteShell(ToPosix(tools.Node))} {QuoteShell(ToPosix(probe))}\n",
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        return new GitFixture(repository, workspaceMarker, externalMarker);
    }

    private static async Task VerifyGitAsync(
        string gitPath,
        ToolchainFixtures fixtures,
        SecurityIdentifier currentSid,
        SecurityIdentifier writeCapabilitySid,
        SecurityIdentifier filesystemCapabilitySid)
    {
        var writeResult = await RunRestrictedAsync(
            Request(
                "workspace-write",
                fixtures.Workspace,
                fixtures.Workspace,
                gitPath,
                GitCommitArgs(fixtures.GitWrite.Repository)),
            currentSid,
            writeCapabilitySid,
            writeCapabilitySid,
            filesystemCapabilitySid);
        Require(
            writeResult.ExitCode == 0 &&
            File.Exists(fixtures.GitWrite.WorkspaceMarker) &&
            !File.Exists(fixtures.GitWrite.ExternalMarker),
            "git_hook_chain_crossed_write_boundary",
            writeResult);

        var readOnlyResult = await RunRestrictedAsync(
            Request(
                "read-only",
                fixtures.Workspace,
                fixtures.Workspace,
                gitPath,
                GitCommitArgs(fixtures.GitReadOnly.Repository)),
            currentSid,
            writeCapabilitySid,
            RestrictedCodeSid,
            filesystemCapabilitySid);
        Require(
            readOnlyResult.ExitCode != 0 &&
            !File.Exists(fixtures.GitReadOnly.WorkspaceMarker) &&
            !File.Exists(fixtures.GitReadOnly.ExternalMarker),
            "git_read_only_chain_wrote_workspace",
            readOnlyResult);
    }

    private static async Task VerifyPythonAsync(
        string pythonPath,
        ToolchainFixtures fixtures,
        SecurityIdentifier currentSid,
        SecurityIdentifier writeCapabilitySid,
        SecurityIdentifier filesystemCapabilitySid)
    {
        var writeResult = await RunRestrictedAsync(
            Request(
                "workspace-write",
                Path.GetDirectoryName(fixtures.PythonScript)!,
                fixtures.Workspace,
                pythonPath,
                [
                    fixtures.PythonScript,
                    "write",
                    fixtures.PythonWorkspaceMarker,
                    fixtures.PythonExternalMarker,
                    fixtures.PythonNestedMarker,
                ]),
            currentSid,
            writeCapabilitySid,
            writeCapabilitySid,
            filesystemCapabilitySid);
        Require(
            writeResult.ExitCode == 0 &&
            File.Exists(fixtures.PythonWorkspaceMarker) &&
            File.Exists(fixtures.PythonNestedMarker) &&
            !File.Exists(fixtures.PythonExternalMarker),
            "python_child_chain_crossed_write_boundary",
            writeResult);

        var readOnlyResult = await RunRestrictedAsync(
            Request(
                "read-only",
                Path.GetDirectoryName(fixtures.PythonScript)!,
                fixtures.Workspace,
                pythonPath,
                [
                    fixtures.PythonScript,
                    "deny",
                    fixtures.PythonReadOnlyMarker,
                    fixtures.PythonExternalMarker,
                    fixtures.PythonNestedMarker,
                ]),
            currentSid,
            writeCapabilitySid,
            RestrictedCodeSid,
            filesystemCapabilitySid);
        Require(
            readOnlyResult.ExitCode == 0 && !File.Exists(fixtures.PythonReadOnlyMarker),
            "python_read_only_chain_wrote_workspace",
            readOnlyResult);
    }

    private static async Task VerifyNpmAsync(
        ToolchainPaths tools,
        ToolchainFixtures fixtures,
        SecurityIdentifier currentSid,
        SecurityIdentifier writeCapabilitySid,
        SecurityIdentifier filesystemCapabilitySid)
    {
        var writeResult = await RunRestrictedAsync(
            Request(
                "workspace-write",
                fixtures.NpmRoot,
                fixtures.Workspace,
                tools.Node,
                [NpmCli(tools), .. NpmRunArgs(fixtures.NpmRoot, "sandbox-write")],
                timeoutMs: 30_000),
            currentSid,
            writeCapabilitySid,
            writeCapabilitySid,
            filesystemCapabilitySid);
        Require(
            writeResult.ExitCode == 0 &&
            File.Exists(fixtures.NpmWorkspaceMarker) &&
            !File.Exists(fixtures.NpmExternalMarker),
            "npm_node_chain_crossed_write_boundary",
            writeResult);
        await Task.Delay(3_000);
        Require(
            !File.Exists(fixtures.NpmResidualMarker),
            "npm_detached_descendant_survived_job_termination",
            writeResult);

        var readOnlyResult = await RunRestrictedAsync(
            Request(
                "read-only",
                fixtures.NpmRoot,
                fixtures.Workspace,
                tools.Node,
                [NpmCli(tools), .. NpmRunArgs(fixtures.NpmRoot, "sandbox-read-only")],
                timeoutMs: 30_000),
            currentSid,
            writeCapabilitySid,
            RestrictedCodeSid,
            filesystemCapabilitySid);
        Require(
            readOnlyResult.ExitCode == 0 && !File.Exists(fixtures.NpmReadOnlyMarker),
            "npm_read_only_chain_wrote_workspace",
            readOnlyResult);
    }

    private static string[] GitCommitArgs(string repository) =>
    [
        "-C",
        repository,
        "-c",
        "user.name=Ariadne Smoke",
        "-c",
        "user.email=smoke@ariadne.invalid",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.hooksPath=.git/hooks",
        "commit",
        "--quiet",
        "--no-gpg-sign",
        "-m",
        "sandbox boundary smoke",
    ];

    private static string[] NpmRunArgs(string root, string script) =>
    [
        "--offline",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts=false",
        "--script-shell",
        Environment.GetEnvironmentVariable("COMSPEC") ?? "cmd.exe",
        "--prefix",
        root,
        "run",
        script,
    ];

    private static string NpmCli(ToolchainPaths tools) => Path.Combine(
        Path.GetDirectoryName(tools.Node)!,
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js");

    private static ExecutionRequest Request(
        string mode,
        string cwd,
        string workspace,
        string file,
        string[] args,
        int timeoutMs = 15_000) => new()
    {
        ExecutionId = Guid.NewGuid().ToString("N"),
        Invocation = new InvocationRequest { Kind = "file", File = file, Args = args.ToList() },
        Cwd = cwd,
        WorkspaceRoot = workspace,
        Mode = mode,
        NetworkMode = "online-approved",
        Environment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
        TimeoutMs = timeoutMs,
        MaxOutputBytes = 1024 * 1024,
        ResourceLimits = new ResourceLimits { MaxProcesses = 32 },
    };

    private static async Task<NativeExecutionResult> RunRestrictedAsync(
        ExecutionRequest request,
        SecurityIdentifier currentSid,
        SecurityIdentifier writerSid,
        SecurityIdentifier restrictionSid,
        SecurityIdentifier filesystemCapabilitySid)
    {
        ExecutionValidator.Validate(request);
        var sink = new ToolchainSink();
        var result = await RestrictedCommandRunner.ExecuteAsync(
            request,
            new RunnerIdentity(
                currentSid.Value,
                writerSid.Value,
                restrictionSid.Value,
                filesystemCapabilitySid.Value,
                RequireWriterMembership: false),
            sink);
        if (sink.StartedCount != 1 || sink.ResultCount != 1)
        {
            throw new InvalidOperationException("toolchain_runner_protocol_terminal_count_invalid");
        }
        return result;
    }

    private static void ConfigureBoundary(
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
        foreach (var descendant in Directory.GetFileSystemEntries(path, "*", SearchOption.AllDirectories))
        {
            var isDirectory = Directory.Exists(descendant);
            FileSystemSecurity childSecurity = isDirectory
                ? new DirectoryInfo(descendant).GetAccessControl(AccessControlSections.Access)
                : new FileInfo(descendant).GetAccessControl(AccessControlSections.Access);
            if (restrictedCapability is not null)
            {
                childSecurity.AddAccessRule(new FileSystemAccessRule(
                    restrictedCapability,
                    FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize,
                    isDirectory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                    PropagationFlags.None,
                    AccessControlType.Allow));
            }
            if (filesystemCapability is not null)
            {
                childSecurity.AddAccessRule(new FileSystemAccessRule(
                    filesystemCapability,
                    FileSystemRights.Modify | FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize,
                    isDirectory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
                    PropagationFlags.None,
                    AccessControlType.Allow));
            }
            if (isDirectory)
            {
                new DirectoryInfo(descendant).SetAccessControl((DirectorySecurity)childSecurity);
            }
            else
            {
                new FileInfo(descendant).SetAccessControl((FileSecurity)childSecurity);
            }
        }
    }

    private static void RunHost(string executable, string[] args)
    {
        var start = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        foreach (var argument in args) start.ArgumentList.Add(argument);
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        start.Environment["GIT_CONFIG_GLOBAL"] = "NUL";
        using var process = Process.Start(start)
            ?? throw new InvalidOperationException("toolchain_fixture_process_start_failed");
        var stdout = process.StandardOutput.ReadToEnd();
        var stderr = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException(
                $"toolchain_fixture_process_failed:{process.ExitCode}:{stdout}:{stderr}");
        }
    }

    private static void RestoreForCleanup(string root, DirectorySecurity rootSecurity)
    {
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal);
        }
        new DirectoryInfo(root).SetAccessControl(rootSecurity);
        Directory.Delete(root, recursive: true);
    }

    private static string RequireTool(string value, string name)
    {
        var fullPath = Path.GetFullPath(value);
        if (!Path.IsPathFullyQualified(value) || !File.Exists(fullPath))
        {
            throw new InvalidOperationException($"toolchain_{name}_unavailable");
        }
        return fullPath;
    }

    private static string QuoteCmd(string value)
    {
        if (value.Contains('"')) throw new InvalidOperationException("toolchain_path_contains_quote");
        return $"\"{value}\"";
    }

    private static string ToPosix(string value) => value.Replace('\\', '/');

    private static string QuoteShell(string value) => $"'{value.Replace("'", "'\"'\"'")}'";

    private static void Require(
        bool condition,
        string code,
        NativeExecutionResult result)
    {
        if (condition) return;
        throw new InvalidOperationException(
            $"{code}:exit={result.ExitCode}:timedOut={result.TimedOut}:stdout={result.Stdout}:stderr={result.Stderr}");
    }

    private sealed record ToolchainPaths(string Git, string Python, string Npm, string Node);

    private sealed record GitFixture(string Repository, string WorkspaceMarker, string ExternalMarker);

    private sealed record ToolchainFixtures(
        string Workspace,
        string External,
        GitFixture GitWrite,
        GitFixture GitReadOnly,
        string PythonScript,
        string PythonWorkspaceMarker,
        string PythonNestedMarker,
        string PythonReadOnlyMarker,
        string PythonExternalMarker,
        string NpmRoot,
        string NpmWorkspaceMarker,
        string NpmReadOnlyMarker,
        string NpmExternalMarker,
        string NpmResidualMarker);

    private sealed class ToolchainSink : INativeExecutionEventSink
    {
        internal int StartedCount { get; private set; }
        internal int ResultCount { get; private set; }

        public void Started(string executionId, int pid, NativeIsolation isolation) => StartedCount++;

        public void Output(string executionId, bool isError, byte[] data)
        {
        }

        public void Result(string executionId, NativeExecutionResult result) => ResultCount++;
    }
}
