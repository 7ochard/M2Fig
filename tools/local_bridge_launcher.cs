using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("MasterGo Figma Bridge")]
[assembly: AssemblyDescription("本地迁移 GUI 启动器")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("2026.11.6.1")]

internal static class LocalBridgeLauncher
{
    private static readonly object LogLock = new object();
    private static readonly string ProjectRoot = AppDomain.CurrentDomain.BaseDirectory;
    private static readonly string LogPath = Path.Combine(ProjectRoot, "artifacts", "gui-launcher", "launcher.log");

    [STAThread]
    private static int Main()
    {
        try
        {
            string script = Path.Combine(ProjectRoot, "tools", "local_bridge_gui.py");
            if (!File.Exists(script))
                throw new FileNotFoundException("未找到 GUI 文件。请将 EXE 保留在完整 Bridge 工程根目录。", script);

            string python;
            string node;
            using (Stream resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Bridge.RuntimePaths"))
            {
                if (resource == null) throw new InvalidOperationException("EXE 缺少本机运行时信息，请重新构建。");
                using (StreamReader reader = new StreamReader(resource, Encoding.UTF8))
                {
                    python = reader.ReadLine();
                    node = reader.ReadLine();
                }
            }
            RequireRuntime(python, "Python");
            RequireRuntime(node, "Node.js");

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = python;
            start.Arguments = "-X utf8 -u \"" + script + "\"";
            start.WorkingDirectory = ProjectRoot;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            start.StandardOutputEncoding = Encoding.UTF8;
            start.StandardErrorEncoding = Encoding.UTF8;
            start.EnvironmentVariables["PYTHONUTF8"] = "1";
            start.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            start.EnvironmentVariables["PATH"] = Path.GetDirectoryName(python) + Path.PathSeparator +
                Path.GetDirectoryName(node) + Path.PathSeparator + (Environment.GetEnvironmentVariable("PATH") ?? "");

            Log("Starting GUI; Python=" + python + "; Node=" + node + "; Root=" + ProjectRoot);
            using (Process process = new Process())
            {
                process.StartInfo = start;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs data)
                {
                    if (data.Data != null) Log("stdout: " + data.Data);
                };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs data)
                {
                    if (data.Data != null) Log("stderr: " + data.Data);
                };
                process.Start();
                Log("GUI process id=" + process.Id);
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                Log("GUI exit code=" + process.ExitCode);
                if (process.ExitCode != 0)
                {
                    ShowFailure("GUI 异常退出，退出码：" + process.ExitCode);
                    return process.ExitCode;
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            Log(error.ToString());
            ShowFailure(error.Message);
            return 1;
        }
    }

    private static void RequireRuntime(string filename, string name)
    {
        if (String.IsNullOrEmpty(filename) || !Path.IsPathRooted(filename) || !File.Exists(filename))
            throw new FileNotFoundException("未找到已配置的 " + name + "。请在本机重新构建启动器。", filename);
    }

    private static void Log(string message)
    {
        lock (LogLock)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath));
                string timestamp = DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(8)).ToString("O");
                File.AppendAllText(LogPath, timestamp + " " + message + Environment.NewLine, new UTF8Encoding(false));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    private static void ShowFailure(string message)
    {
        MessageBox.Show(message + Environment.NewLine + Environment.NewLine + "启动日志：" + LogPath,
            "MasterGo → Figma 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}
