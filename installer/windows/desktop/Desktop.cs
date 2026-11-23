using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class Desktop
{
    internal static readonly string DataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Anyswitch");
    internal static readonly string AppRoot = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), ".."));
    internal static readonly string VersionRoot = Path.GetDirectoryName(AppRoot);
    internal static readonly string InstallRoot = Path.GetDirectoryName(Path.GetDirectoryName(VersionRoot));

    [STAThread]
    private static int Main(string[] args)
    {
        var mode = args.Length == 1 ? args[0] : "--window";
        if (mode == "--health") return File.Exists(Path.Combine(AppRoot, "anyswitch.ico")) ? 0 : 1;
        var name = "Local\\Anyswitch.Desktop." + WindowsIdentity.GetCurrent().User.Value;
        using (var mutex = new Mutex(false, name))
        using (var activate = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".activate"))
        using (var shutdown = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".shutdown"))
        {
            bool first = Acquire(mutex, 0);
            if (mode == "--shutdown")
            {
                if (!first)
                {
                    shutdown.Set();
                    if (!Acquire(mutex, 115000)) return 1;
                }
                try { return RunServices("stop").GetAwaiter().GetResult() ? 0 : 1; }
                finally { mutex.ReleaseMutex(); }
            }
            if (!first)
            {
                if (mode == "--window") activate.Set();
                return 0;
            }
            var nextMode = "";
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var context = new TrayApplication(mode, activate, shutdown))
                {
                    Application.Run(context);
                    nextMode = context.NextMode;
                }
            }
            catch (Exception error) { Log(error.ToString()); return 1; }
            finally { mutex.ReleaseMutex(); }
            if (nextMode.Length != 0)
                Process.Start(new ProcessStartInfo(Path.Combine(InstallRoot, "Anyswitch.exe"), nextMode) { UseShellExecute = false });
            return 0;
        }
    }

    private static bool Acquire(Mutex mutex, int milliseconds)
    {
        try { return mutex.WaitOne(milliseconds); }
        catch (AbandonedMutexException) { return true; }
    }

    internal static Task<bool> RunServices(string action)
    {
        return Task.Run(() =>
        {
            try
            {
                var path = Path.Combine(VersionRoot, "runtime", "node.exe");
                var script = Path.Combine(AppRoot, "src", "ops", "desktop-lifecycle.mjs");
                var info = new ProcessStartInfo(path, "\"" + script + "\" " + action) {
                    UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AppRoot,
                    RedirectStandardError = true
                };
                info.EnvironmentVariables["ANYSWITCH_INSTALL_ROOT"] = InstallRoot;
                info.EnvironmentVariables["ANYSWITCH_APP_ROOT"] = AppRoot;
                info.EnvironmentVariables["ANYSWITCH_NODE_PATH"] = path;
                using (var child = Process.Start(info))
                {
                    child.ErrorDataReceived += (sender, e) => { if (e.Data != null) Log(e.Data); };
                    child.BeginErrorReadLine();
                    if (child.WaitForExit(action == "stop" ? 105000 : 20000)) return child.ExitCode == 0;
                    child.Kill();
                    Log("Service request timed out: " + action);
                    return false;
                }
            }
            catch (Exception error) { Log(error.Message); return false; }
        });
    }

    internal static void Log(string message)
    {
        try
        {
            var dir = Path.Combine(DataRoot, "logs");
            Directory.CreateDirectory(dir);
            File.AppendAllText(Path.Combine(dir, "desktop.log"), DateTimeOffset.Now + " " + message + Environment.NewLine);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

internal sealed class TrayApplication : ApplicationContext
{
    private static readonly Uri Panel = new Uri("http://127.0.0.1:47820/panel");
    private readonly EventWaitHandle activate;
    private readonly EventWaitHandle shutdown;
    private readonly System.Windows.Forms.Timer timer;
    private readonly NotifyIcon tray;
    private readonly ContextMenuStrip menu;
    private readonly Icon icon;
    private readonly Dictionary<string, string> copy;
    private Form window;
    private WebView2 view;
    private bool exiting;
    private bool polling;
    private bool initializing;
    private bool rendererFailed;
    private bool disposed;
    private readonly SemaphoreSlim serviceRequests = new SemaphoreSlim(1);
    private Task<bool> startTask;
    internal string NextMode { get; private set; }

    internal TrayApplication(string mode, EventWaitHandle activate, EventWaitHandle shutdown)
    {
        this.activate = activate;
        this.shutdown = shutdown;
        NextMode = "";
        copy = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(
            File.ReadAllText(Path.Combine(Desktop.AppRoot, "desktop", "copy.json")));
        icon = new Icon(Path.Combine(Desktop.AppRoot, "anyswitch.ico"));
        menu = new ContextMenuStrip();
        menu.Items.Add(copy["open"], null, async (sender, e) => await OpenWindow());
        menu.Items.Add(copy["browser"], null, async (sender, e) => await OpenBrowser());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(copy["exit"], null, async (sender, e) => await Quit(true));
        tray = new NotifyIcon { Icon = icon, ContextMenuStrip = menu, Text = "Anyswitch", Visible = true };
        tray.DoubleClick += async (sender, e) => await OpenWindow();
        timer = new System.Windows.Forms.Timer { Interval = 400 };
        timer.Tick += async (sender, e) => await Poll();
        timer.Start();
        if (mode == "--window" || mode == "--resume-window") activate.Set();
        startTask = mode.StartsWith("--resume-", StringComparison.Ordinal) ? Task.FromResult(true) : Desktop.RunServices("start");
    }

    private async Task OpenWindow()
    {
        if (exiting || initializing) return;
        if (window != null && !window.IsDisposed && !rendererFailed)
        {
            window.Show();
            if (window.WindowState == FormWindowState.Minimized) window.WindowState = FormWindowState.Normal;
            window.Activate();
            return;
        }
        initializing = true;
        try
        {
            await startTask;
            if (exiting) return;
            if (!await EnsurePanel()) return;
            if (exiting) return;
            window = new Form { Text = "Anyswitch", Icon = icon, Width = 1280, Height = 860, MinimumSize = new Size(480, 420), StartPosition = FormStartPosition.CenterScreen };
            var openedWindow = window;
            window.FormClosing += (sender, e) => {
                if (!exiting && e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; openedWindow.Hide(); }
            };
            window.FormClosed += (sender, e) => {
                if (window == openedWindow) window = null;
            };
            view = new WebView2 { Dock = DockStyle.Fill };
            window.Controls.Add(view);
            var handle = window.Handle;
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Desktop.DataRoot, "webview"));
            if (exiting || openedWindow.IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            if (exiting || openedWindow.IsDisposed) return;
            var core = view.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = false;
            core.NavigationStarting += (sender, e) => {
                if (IsPanelUri(e.Uri)) return;
                e.Cancel = true;
                OpenExternal(e.Uri);
            };
            core.NewWindowRequested += (sender, e) => {
                e.Handled = true;
                OpenExternal(e.Uri);
            };
            core.ProcessFailed += (sender, e) => {
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited && window == openedWindow && !openedWindow.IsDisposed) {
                    rendererFailed = true;
                    openedWindow.BeginInvoke(new Action(() => {
                        openedWindow.Dispose();
                        if (window == openedWindow) window = null;
                    }));
                }
            };
            rendererFailed = false;
            core.Navigate(Panel + "?startup=1");
            window.Show();
            window.Activate();
        }
        catch (Exception error)
        {
            Desktop.Log(error.Message);
            if (window != null) { window.Dispose(); window = null; }
        }
        finally { initializing = false; }
        if (window == null && !exiting) await OpenBrowser();
    }

    private static bool IsPanelUri(string value)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "http" && uri.Host == Panel.Host &&
            uri.Port == Panel.Port && uri.UserInfo.Length == 0 && (uri.AbsolutePath == "/panel" || uri.AbsolutePath.StartsWith("/panel/", StringComparison.Ordinal));
    }

    private static void OpenExternal(string value)
    {
        Uri uri;
        if (!Uri.TryCreate(value, UriKind.Absolute, out uri) || (uri.Scheme != "http" && uri.Scheme != "https")) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception error) { Desktop.Log(error.Message); }
    }

    private async Task OpenBrowser()
    {
        if (exiting) return;
        await startTask;
        if (!exiting && await EnsurePanel() && !exiting) OpenExternal(Panel.AbsoluteUri);
    }

    private async Task<bool> EnsurePanel()
    {
        await serviceRequests.WaitAsync();
        try { return !exiting && (await PanelAvailable() || (!exiting && await Desktop.RunServices("open"))); }
        finally { serviceRequests.Release(); }
    }

    private static async Task<Dictionary<string, object>> ReadPanel(string endpoint)
    {
        try
        {
            using (var client = new WebClient { Proxy = null })
            {
                var read = client.DownloadStringTaskAsync(new Uri(Panel + "/api/" + endpoint));
                if (await Task.WhenAny(read, Task.Delay(1500)) != read) {
                    client.CancelAsync();
                    return null;
                }
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(await read);
            }
        }
        catch { return null; }
    }

    private static async Task<bool> PanelAvailable()
    {
        var info = await ReadPanel("app-info");
        object version;
        return info != null && info.TryGetValue("version", out version) && version is string;
    }

    private async Task Poll()
    {
        if (exiting || polling) return;
        if (shutdown.WaitOne(0)) { await Quit(false); return; }
        if (activate.WaitOne(0)) { await OpenWindow(); return; }
        if (initializing) return;
        polling = true;
        try
        {
            var version = Bootstrap.ReadVersion(Desktop.InstallRoot);
            if (version == Path.GetFileName(Desktop.VersionRoot)) return;
            var last = await ReadPanel("self-update/last");
            object outcome, afterVersion;
            if (last == null || !last.TryGetValue("outcome", out outcome) || !Equals(outcome, "updated") ||
                !last.TryGetValue("afterVersion", out afterVersion) || !Equals(afterVersion, version) || exiting) return;
            if (shutdown.WaitOne(0)) { await Quit(false); return; }
            NextMode = window != null && window.Visible ? "--resume-window" : "--resume-tray";
            exiting = true;
            ExitThread();
        }
        catch (IOException) { }
        catch (ArgumentException) { }
        catch (KeyNotFoundException) { }
        catch (InvalidOperationException) { }
        finally { polling = false; }
    }

    private async Task Quit(bool confirm)
    {
        if (exiting) return;
        if (confirm && MessageBox.Show(copy["exitBody"], copy["exitTitle"], MessageBoxButtons.YesNo,
              MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return;
        exiting = true;
        await startTask;
        await serviceRequests.WaitAsync();
        try
        {
            if (await Desktop.RunServices("stop")) ExitThread();
            else exiting = false;
        }
        finally { serviceRequests.Release(); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            disposed = true;
            timer.Dispose();
            tray.Visible = false;
            tray.Dispose();
            menu.Dispose();
            if (window != null) window.Dispose();
            icon.Dispose();
        }
        base.Dispose(disposing);
    }
}
