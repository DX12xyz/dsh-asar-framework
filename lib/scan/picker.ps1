# Folder picker for the DSH asar bridge install page.
#
# Windows PowerShell 5.1 loads this file as ANSI unless it carries a UTF-8 BOM,
# and the interop below is kept in pure ASCII on purpose. The modern folder
# dialog is IFileDialog with FOS_PICKFOLDERS; it is shown on a NEW STA THREAD
# because PowerShell's own thread has a pinned UI language, which made the
# dialog's internal labels stay English on a Chinese system.
#
# Output contract: exactly one line on stdout - the chosen folder path.
# Cancelling prints nothing and exits 0. Any real failure exits non-zero.

[CmdletBinding()]
param(
    [string] $Title = 'Select the DSH desktop install directory'
)

if (-not ('DshFolderPicker' -as [type])) {
    $source = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class DshFolderPicker
{
    private const int FOS_PICKFOLDERS = 0x00000020;
    private const int FOS_FORCEFILESYSTEM = 0x00000040;
    private const int FOS_PATHMUSTEXIST = 0x00000800;
    private const int SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = 0x800704C7;

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        [PreserveSig] int SetFileTypes(uint count, IntPtr types);
        [PreserveSig] int SetFileTypeIndex(uint index);
        [PreserveSig] int GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        [PreserveSig] int SetOptions(uint options);
        [PreserveSig] int GetOptions(out uint options);
        [PreserveSig] int SetDefaultFolder(IntPtr folder);
        [PreserveSig] int SetFolder(IntPtr folder);
        [PreserveSig] int GetFolder(out IntPtr folder);
        [PreserveSig] int GetCurrentName(out IntPtr name);
        [PreserveSig] int Close();
        [PreserveSig] int SetFileName(IntPtr name);
        [PreserveSig] int GetFileName(out IntPtr name);
        [PreserveSig] int SetTitle(IntPtr title);
        [PreserveSig] int SetOkButtonLabel(IntPtr text);
        [PreserveSig] int SetFileNameLabel(IntPtr label);
        [PreserveSig] int GetResult(out IntPtr item);
        [PreserveSig] int AddPlace(IntPtr item, int placement);
        [PreserveSig] int SetDefaultExtension(IntPtr name);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr filter);
        [PreserveSig] int SetMinFileListSize(uint size);
        [PreserveSig] int SetCollectedProperties(IntPtr properties, int unk);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr handler, ref Guid id, ref Guid riid, out IntPtr result);
        [PreserveSig] int GetParent(out IntPtr parent);
        [PreserveSig] int GetDisplayName(int sigdnName, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IntPtr other, uint hint, out int order);
    }

    private static string picked;
    private static int failure;
    private static string failureMessage;

    public static string Pick(string title)
    {
        picked = null;
        failure = 0;
        failureMessage = null;

        Thread thread = new Thread(new ThreadStart(delegate { ShowDialog(title); }));
        thread.SetApartmentState(ApartmentState.STA);
        thread.IsBackground = false;
        thread.Start();
        thread.Join();

        if (failure != 0)
        {
            throw new InvalidOperationException(failureMessage == null ? "folder picker failed" : failureMessage);
        }
        return picked;
    }

    private static void ShowDialog(string title)
    {
        IntPtr titlePtr = IntPtr.Zero;
        try
        {
            object raw = new FileOpenDialog();
            IFileDialog dialog = (IFileDialog)raw;

            uint options;
            int hr = dialog.GetOptions(out options);
            if (hr < 0) { Fail(hr, "GetOptions"); return; }
            hr = dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            if (hr < 0) { Fail(hr, "SetOptions"); return; }

            if (!string.IsNullOrEmpty(title))
            {
                titlePtr = Marshal.StringToHGlobalUni(title);
                dialog.SetTitle(titlePtr);
            }

            hr = dialog.Show(IntPtr.Zero);
            if (hr == ERROR_CANCELLED)
            {
                picked = null;
                return;
            }
            if (hr < 0) { Fail(hr, "Show"); return; }

            IntPtr itemPtr;
            hr = dialog.GetResult(out itemPtr);
            if (hr < 0) { Fail(hr, "GetResult"); return; }

            IShellItem item = (IShellItem)Marshal.GetObjectForIUnknown(itemPtr);
            IntPtr pathPtr;
            hr = item.GetDisplayName(SIGDN_FILESYSPATH, out pathPtr);
            if (hr < 0)
            {
                Marshal.ReleaseComObject(item);
                Marshal.Release(itemPtr);
                Fail(hr, "GetDisplayName");
                return;
            }
            picked = Marshal.PtrToStringUni(pathPtr);
            Marshal.FreeCoTaskMem(pathPtr);
            Marshal.ReleaseComObject(item);
            Marshal.Release(itemPtr);
        }
        catch (Exception error)
        {
            failureMessage = error.Message;
            failure = 3;
        }
        finally
        {
            if (titlePtr != IntPtr.Zero) Marshal.FreeHGlobal(titlePtr);
        }
    }

    private static void Fail(int hr, string where)
    {
        failureMessage = where + " failed with HRESULT 0x" + hr.ToString("X8");
        failure = 2;
    }
}
'@
    try {
        Add-Type -TypeDefinition $source -Language CSharp -IgnoreWarnings -ErrorAction Stop
    } catch {
        [Console]::Error.WriteLine("Add-Type failed: " + $_.Exception.Message)
        exit 4
    }
}

try {
    $folder = [DshFolderPicker]::Pick($Title)
} catch {
    [Console]::Error.WriteLine("picker failed: " + $_.Exception.Message)
    exit 5
}

if ([string]::IsNullOrEmpty($folder)) {
    exit 0
}

[Console]::Out.WriteLine($folder)
exit 0
