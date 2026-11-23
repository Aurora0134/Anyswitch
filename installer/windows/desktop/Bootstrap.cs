using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class Bootstrap
{
    internal static string InstallRoot { get { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); } }

    internal static string ReadVersion(string root)
    {
        var json = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(
            File.ReadAllText(Path.Combine(root, "current.json")));
        var version = json["version"] as string;
        if (json.Count != 2 || !Equals(json["schema"], 1) || version == null ||
            !Regex.IsMatch(version, @"\A[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\z"))
            throw new InvalidDataException("Invalid active version");
        return version;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            var mode = args.Length == 1 ? args[0] : "--window";
            if (mode != "--window" && mode != "--tray" && mode != "--resume-window" && mode != "--resume-tray" && mode != "--shutdown") return 1;
            var root = InstallRoot;
            var versionRoot = Path.Combine(root, "versions", ReadVersion(root));
            var start = new ProcessStartInfo(Path.Combine(versionRoot, "app", "desktop", "Anyswitch.Desktop.exe"), mode);
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            using (var child = Process.Start(start))
            {
                if (mode != "--shutdown") return 0;
                return child.WaitForExit(225000) ? child.ExitCode : 1;
            }
        }
        catch (Exception error)
        {
            EventLogError(error);
            return 1;
        }
    }

    private static void EventLogError(Exception error)
    {
        try
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Anyswitch", "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "desktop.log"), DateTimeOffset.Now + " " + error.Message + Environment.NewLine);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}
