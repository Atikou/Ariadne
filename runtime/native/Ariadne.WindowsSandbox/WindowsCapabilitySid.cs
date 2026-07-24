using System.Security.Principal;

namespace Ariadne.WindowsSandbox;

internal static class WindowsCapabilitySid
{
    internal static SecurityIdentifier Create()
    {
        var bytes = Guid.NewGuid().ToByteArray();
        static uint Part(byte[] source, int offset) =>
            (BitConverter.ToUInt32(source, offset) & 0x3FFFFFFF) + 0x10000000;
        return new SecurityIdentifier(
            $"S-1-5-21-{Part(bytes, 0)}-{Part(bytes, 4)}-{Part(bytes, 8)}-{Part(bytes, 12)}");
    }
}
