using System;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Media;
using Serilog;

namespace ScanNTune.App.Views;

public partial class MainWindow : Window
{
    public const string RepositoryUrl = "https://github.com/jaak0b/ScanNTune";

    // The maximize button swaps between these two glyphs as the window state changes.
    private readonly Geometry _maximizeIcon = Geometry.Parse("M0,0 H10 V10 H0 Z");
    private readonly Geometry _restoreIcon = Geometry.Parse("M0,3 H7 V10 H0 Z M3,3 V0 H10 V7 H7");

    public MainWindow()
    {
        InitializeComponent();

        // Drop the native title bar + caption buttons (Avalonia 12 only draws them for
        // WindowDecorations.Full) but keep the resizable border, then extend our own chrome over the top.
        WindowDecorations = WindowDecorations.BorderOnly;
        ExtendClientAreaToDecorationsHint = true;
    }

    private void OnTitleBarPressed(object? sender, PointerPressedEventArgs e)
    {
        if (e.GetCurrentPoint(this).Properties.IsLeftButtonPressed)
            BeginMoveDrag(e);
    }

    private void OnTitleBarDoubleTapped(object? sender, TappedEventArgs e) => ToggleMaximize();

    private void OnMinimize(object? sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void OnMaximizeRestore(object? sender, RoutedEventArgs e) => ToggleMaximize();

    private void OnClose(object? sender, RoutedEventArgs e) => Close();

    private async void OnOpenRepository(object? sender, RoutedEventArgs e)
    {
        try
        {
            await Launcher.LaunchUriAsync(new Uri(RepositoryUrl));
        }
        catch (Exception ex)
        {
            Log.ForContext<MainWindow>().Error(ex, "Could not open the repository URL {Url}.", RepositoryUrl);
        }
    }

    private void ToggleMaximize()
        => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property == WindowStateProperty)
            MaxIcon.Data = WindowState == WindowState.Maximized ? _restoreIcon : _maximizeIcon;
    }
}
