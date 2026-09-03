// Native OS UI Dialog Helpers: Browser Auto-Launch and Native Folder Picker Dialogs

import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';

/**
 * Automatically opens the default system web browser to the Web UI URL.
 */
export function openBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      exec(`start "" "${url}"`);
    } else if (platform === 'darwin') {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  } catch {}
}

/**
 * Pops open the host OS's native folder selection dialog (Windows WinForms, Linux Zenity/Kdialog/Tk, macOS AppleScript).
 * Returns the selected folder path string, or null if cancelled.
 */
export function pickFolder(initialDir) {
  return new Promise((resolve) => {
    const platform = process.platform;

    if (platform === 'win32') {
      // A hidden TopMost owner form forces the dialog in front of all windows.
      const psScript = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$f.Description = "Select DISLogger Log Folder"',
        '$f.ShowNewFolderButton = $true',
        initialDir ? `$f.SelectedPath = '${initialDir}'` : '',
        '$owner = New-Object System.Windows.Forms.Form',
        '$owner.TopMost = $true',
        '$owner.Width = 0; $owner.Height = 0',
        '$owner.StartPosition = "CenterScreen"',
        '$owner.Show(); $owner.BringToFront()',
        'if ($f.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [Console]::WriteLine($f.SelectedPath)',
        '}',
        '$owner.Dispose()',
      ].filter(Boolean).join('\r\n');

      const tempPs1 = path.join(os.tmpdir(), `dislogger_pick_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
      try {
        fs.writeFileSync(tempPs1, psScript, 'utf8');
        exec(`powershell -NoProfile -ExecutionPolicy Bypass -STA -File "${tempPs1}"`, (err, stdout) => {
          try { fs.unlinkSync(tempPs1); } catch {}
          if (err || !stdout) {
            resolve(null);
          } else {
            resolve(stdout.trim() || null);
          }
        });
      } catch {
        resolve(null);
      }
      return;
    }

    if (platform === 'darwin') {
      const loc = initialDir ? ` default location POSIX file "${initialDir.replace(/"/g, '\\"')}"` : '';
      exec(`osascript -e 'POSIX path of (choose folder with prompt "Select DISLogger Log Folder"${loc})'`, (err, stdout) => {
        if (err || !stdout) resolve(null);
        else resolve(stdout.trim().replace(/\/$/, '') || null);
      });
      return;
    }

    // Linux fallback chain — zenity, kdialog, then tkinter
    const safeDir = (initialDir || '').replace(/'/g, "'\\''");
    const zenityStart  = initialDir ? `--filename='${safeDir}/'` : '';
    const kdialogStart = initialDir ? `'${safeDir}'` : '';
    const tkStart      = initialDir ? `initialdir='${safeDir}',` : '';
    const cmd = [
      `zenity --file-selection --directory --title="Select DISLogger Log Folder" ${zenityStart} 2>/dev/null`,
      `kdialog --getexistingdirectory ${kdialogStart} 2>/dev/null`,
      `python3 -c "import tkinter as t; from tkinter import filedialog as f; root=t.Tk(); root.withdraw(); print(f.askdirectory(${tkStart}title='Select DISLogger Log Folder'))" 2>/dev/null`,
    ].join(' || ');
    exec(cmd, (err, stdout) => {
      if (err || !stdout) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}
