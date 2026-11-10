// The bridge's Windows helper. windows.js starts Windows PowerShell 5.1 with
//
//   Add-Type -LiteralPath <this file> -ReferencedAssemblies System.Web.Extensions
//   [T3CodeWow.Helper]::Run()
//
// so this is compiled on the player's PC each time the bridge starts, by the compiler
// inside .NET Framework 4.x, which ships with Windows 10 and 11. That compiler stops at
// C# 5: no string interpolation, no ?. operator, no expression-bodied members, no
// `out var`, no nameof. `cd bridge && npm test` on Windows compiles this file, so a
// newer construct fails there and not on someone's desktop.
//
// PowerShell only hosts the process. Run() reads and writes the process's own standard
// streams as bytes, so nothing passes through PowerShell's text pipeline.
//
// Protocol
//
// Request (stdin): one line of UTF-8 JSON ending in \n.
//     {"id":<int>,"op":"<name>", ...arguments}
// Reply (stdout): one line of UTF-8 JSON ending in \n, then exactly `bytes` raw bytes.
//     {"id":<same>,"ok":true, ...fields,"bytes":<n>}
//     {"id":<same>,"ok":false,"error":"<what went wrong>","bytes":0}
// Requests are answered one at a time, in order. Before the first request the helper
// writes one frame with no id:
//     {"ready":true,"bytes":0}
//
//   op        arguments             reply fields                                  data
//   procs     name                  procs: [{pid, path|null, startMs}]            none
//
// The helper exits with code 0 when stdin closes, and when the bridge's process
// (T3WOW_PARENT_PID) is gone. Anything written to stderr is for people: windows.js
// puts it in its error message.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace T3CodeWow {
  public static class Helper {
    [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }

    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out FILETIME created, out FILETIME exited, out FILETIME kernel, out FILETIME user);

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    // A FILETIME counts 100 ns steps from 1601. The bridge wants ms from 1970.
    const long MS_FROM_1601_TO_1970 = 11644473600000;

    /// Fills in the reply's fields and returns the bytes that follow it, or null for none.
    delegate byte[] Operation(Dictionary<string, object> request, Dictionary<string, object> reply);

    static readonly Dictionary<string, Operation> operations = new Dictionary<string, Operation> {
      { "procs", Procs },
    };

    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static Stream output;

    /// The only entry point. Returns when stdin closes.
    public static void Run() {
      WatchParent();
      output = Console.OpenStandardOutput();
      StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      Dictionary<string, object> hello = new Dictionary<string, object>();
      hello["ready"] = true;
      Reply(hello, null);
      string line;
      while ((line = input.ReadLine()) != null) {
        Dictionary<string, object> reply = new Dictionary<string, object>();
        byte[] data = null;
        try {
          Dictionary<string, object> request = json.Deserialize<Dictionary<string, object>>(line);
          reply["id"] = request["id"];
          string op = (string)request["op"];
          Operation operation;
          if (!operations.TryGetValue(op, out operation)) throw new ArgumentException("the helper has no operation called " + op);
          data = operation(request, reply);
          reply["ok"] = true;
        } catch (Exception e) {
          // One bad request never ends the helper.
          object id;
          reply.TryGetValue("id", out id);
          reply = new Dictionary<string, object>();
          reply["id"] = id;
          reply["ok"] = false;
          reply["error"] = e.Message;
          data = null;
        }
        Reply(reply, data);
      }
    }

    /// Stdin closing is how the helper normally learns the bridge is gone. This thread
    /// covers the case where the main thread is stuck inside a Windows call and can't
    /// notice.
    static void WatchParent() {
      int pid;
      if (!int.TryParse(Environment.GetEnvironmentVariable("T3WOW_PARENT_PID"), out pid)) return;
      Thread watcher = new Thread(delegate() {
        try {
          Process.GetProcessById(pid).WaitForExit();
        } catch (ArgumentException) {
          // Gone already.
        } catch (Exception) {
          // Windows won't let us watch it. Stdin closing still ends the helper.
          return;
        }
        Environment.Exit(0);
      });
      watcher.IsBackground = true;
      watcher.Start();
    }

    /// Write one frame: the JSON line with "bytes" set, then the data.
    static void Reply(Dictionary<string, object> head, byte[] data) {
      head["bytes"] = data == null ? 0 : data.Length;
      byte[] line = Encoding.UTF8.GetBytes(json.Serialize(head) + "\n");
      try {
        output.Write(line, 0, line.Length);
        if (data != null) output.Write(data, 0, data.Length);
        output.Flush();
      } catch (IOException) {
        // The bridge closed its end.
        Environment.Exit(0);
      }
    }

    /// procs: every running program with this image name (no ".exe"). The path and
    /// start time come from OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION), not from
    /// Process.MainModule and Process.StartTime, which fail with "Access is denied" when
    /// the game runs as administrator and the bridge doesn't. startMs is the creation
    /// time as ms since 1970 UTC, so a change of time zone doesn't look like a new client.
    static byte[] Procs(Dictionary<string, object> request, Dictionary<string, object> reply) {
      List<object> procs = new List<object>();
      foreach (Process process in Process.GetProcessesByName((string)request["name"])) {
        using (process) {
          IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)process.Id);
          if (handle == IntPtr.Zero) continue;
          try {
            FILETIME created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) continue;
            StringBuilder path = new StringBuilder(1024);
            uint size = (uint)path.Capacity;
            Dictionary<string, object> entry = new Dictionary<string, object>();
            entry["pid"] = process.Id;
            entry["path"] = QueryFullProcessImageName(handle, 0, path, ref size) ? path.ToString() : null;
            entry["startMs"] = (long)((((ulong)created.High << 32) | created.Low) / 10000) - MS_FROM_1601_TO_1970;
            procs.Add(entry);
          } finally {
            CloseHandle(handle);
          }
        }
      }
      reply["procs"] = procs;
      return null;
    }
  }
}
