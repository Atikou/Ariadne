using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Ariadne.WindowsSandbox;

internal static partial class PathPolicy
{
    private const int MaxRoots = 64;

    internal static DesiredPolicy Normalize(SetupRequest request, string argumentStateRoot)
    {
        var stateRoot = NormalizeAbsolute(request.StateRoot, nameof(request.StateRoot));
        var expectedStateRoot = NormalizeAbsolute(argumentStateRoot, "--state-root");
        if (!PathEquals(stateRoot, expectedStateRoot))
        {
            throw new RequestException("stateRoot does not match --state-root");
        }

        var workspaceRoot = NormalizeAbsolute(request.WorkspaceRoot, nameof(request.WorkspaceRoot));
        if (!Directory.Exists(workspaceRoot))
        {
            throw new RequestException("workspaceRoot must reference an existing directory");
        }

        var writableRoots = NormalizeRoots(request.WritableRoots, nameof(request.WritableRoots));
        var toolReadRoots = NormalizeRoots(request.ToolReadRoots, nameof(request.ToolReadRoots));
        var readOnlySubpaths = NormalizeRoots(request.ReadOnlySubpaths, nameof(request.ReadOnlySubpaths));
        ValidateAccountName(request.OfflineUser, nameof(request.OfflineUser));
        ValidateAccountName(request.OnlineUser, nameof(request.OnlineUser));
        ValidateAccountName(request.WriterGroup, nameof(request.WriterGroup));
        if (string.Equals(request.OfflineUser, request.OnlineUser, StringComparison.OrdinalIgnoreCase))
        {
            throw new RequestException("offlineUser and onlineUser must be different accounts");
        }

        var writableBoundary = new[] { workspaceRoot }.Concat(writableRoots).ToArray();
        if (writableBoundary.Any(root => PathsOverlap(stateRoot, root)))
        {
            throw new RequestException("stateRoot must be outside all sandbox-writable roots");
        }
        if (toolReadRoots.Any(root => PathsOverlap(stateRoot, root)))
        {
            throw new RequestException("stateRoot must be outside all sandbox-readable tool roots");
        }
        foreach (var toolRoot in toolReadRoots)
        {
            if (!Directory.Exists(toolRoot))
            {
                throw new RequestException("every toolReadRoot must reference an existing directory");
            }
        }
        foreach (var protectedPath in readOnlySubpaths)
        {
            if (!writableBoundary.Any(root => IsSameOrDescendant(protectedPath, root)))
            {
                throw new RequestException("every readOnlySubpath must be inside workspaceRoot or writableRoots");
            }
        }

        var digestInput = new
        {
            version = 2,
            stateRoot,
            workspaceRoot,
            writableRoots,
            toolReadRoots,
            readOnlySubpaths,
            offlineUser = request.OfflineUser,
            onlineUser = request.OnlineUser,
            writerGroup = request.WriterGroup,
            allowLoopback = request.AllowLoopback,
        };
        var canonicalJson = JsonSerializer.Serialize(digestInput, JsonProtocol.Options);
        var digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalJson)));
        return new DesiredPolicy(
            stateRoot,
            workspaceRoot,
            writableRoots,
            toolReadRoots,
            readOnlySubpaths,
            request.OfflineUser,
            request.OnlineUser,
            request.WriterGroup,
            request.AllowLoopback,
            digest);
    }

    internal static string NormalizeAbsolute(string value, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
        {
            throw new RequestException($"{fieldName} must be an absolute path");
        }
        if (value.StartsWith("\\\\.\\", StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith("\\\\?\\GLOBALROOT", StringComparison.OrdinalIgnoreCase))
        {
            throw new RequestException($"{fieldName} uses a forbidden device path");
        }
        if (value.StartsWith("\\\\", StringComparison.Ordinal))
        {
            throw new RequestException($"{fieldName} must not be a UNC path");
        }

        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(value);
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new RequestException($"{fieldName} is invalid: {error.Message}");
        }
        var canonical = WindowsPathResolver.Canonicalize(fullPath);
        var root = Path.GetPathRoot(canonical);
        return string.Equals(canonical, root, StringComparison.OrdinalIgnoreCase)
            ? canonical
            : Path.TrimEndingDirectorySeparator(canonical);
    }

    internal static bool PathEquals(string left, string right) =>
        string.Equals(left, right, StringComparison.OrdinalIgnoreCase);

    internal static bool IsSameOrDescendant(string candidate, string root)
    {
        if (PathEquals(candidate, root))
        {
            return true;
        }
        var prefix = Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar;
        return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
    }

    private static IReadOnlyList<string> NormalizeRoots(IReadOnlyCollection<string> values, string fieldName)
    {
        if (values.Count > MaxRoots)
        {
            throw new RequestException($"{fieldName} must contain at most {MaxRoots} paths");
        }
        var normalized = values.Select((value, index) => NormalizeAbsolute(value, $"{fieldName}[{index}]")).ToArray();
        if (normalized.Distinct(StringComparer.OrdinalIgnoreCase).Count() != normalized.Length)
        {
            throw new RequestException($"{fieldName} must not contain duplicate paths");
        }
        Array.Sort(normalized, StringComparer.OrdinalIgnoreCase);
        return normalized;
    }

    private static bool PathsOverlap(string left, string right) =>
        IsSameOrDescendant(left, right) || IsSameOrDescendant(right, left);

    private static void ValidateAccountName(string value, string fieldName)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 20 || !AccountNamePattern().IsMatch(value))
        {
            throw new RequestException($"{fieldName} must contain only letters, digits, underscores, or hyphens");
        }
    }

    [GeneratedRegex("^[A-Za-z0-9_-]+$", RegexOptions.CultureInvariant)]
    private static partial Regex AccountNamePattern();
}
