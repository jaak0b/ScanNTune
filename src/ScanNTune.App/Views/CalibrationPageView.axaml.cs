using System;
using System.Threading.Tasks;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using Avalonia.Markup.Xaml;
using Avalonia.Platform.Storage;
using Serilog;
using ScanNTune.App.ViewModels;

namespace ScanNTune.App.Views;

public partial class CalibrationPageView : UserControl
{
    public CalibrationPageView()
    {
        InitializeComponent();

        // Drag-and-drop has no XAML attribute for its routed events, so wire it in code. The whole
        // page is the drop target, so a card can be dropped over the upload prompt or the result.
        if (this.FindControl<ScrollViewer>("PageDrop") is { } zone)
        {
            zone.AddHandler(DragDrop.DragOverEvent, OnDragOver);
            zone.AddHandler(DragDrop.DropEvent, OnDrop);
        }
    }

    private void InitializeComponent() => AvaloniaXamlLoader.Load(this);

    private void OnDragOver(object? sender, DragEventArgs e) =>
        e.DragEffects = e.DataTransfer.Contains(DataFormat.File) ? DragDropEffects.Copy : DragDropEffects.None;

    private void OnDrop(object? sender, DragEventArgs e)
    {
        if (DataContext is CalibrationPageViewModel vm && e.DataTransfer.TryGetFile()?.TryGetLocalPath() is { } path)
            _ = vm.LoadScanAsync(path);
    }

    private void OnUpload(object? sender, RoutedEventArgs e) => _ = PickAsync();

    // Guarded so a picker failure surfaces on the page rather than escaping the sync event handler.
    private async Task PickAsync()
    {
        if (DataContext is not CalibrationPageViewModel vm)
            return;

        try
        {
            IStorageProvider? storage = TopLevel.GetTopLevel(this)?.StorageProvider;
            if (storage is null)
                return;

            var files = await storage.OpenFilePickerAsync(new FilePickerOpenOptions
            {
                Title = "Open the reference card scan",
                AllowMultiple = false,
                FileTypeFilter =
                [
                    new FilePickerFileType("Images")
                    {
                        Patterns = ["*.png", "*.jpg", "*.jpeg", "*.bmp", "*.tif", "*.tiff"]
                    }
                ]
            });

            if (files.Count > 0 && files[0].TryGetLocalPath() is { } path)
                await vm.LoadScanAsync(path);
        }
        catch (Exception ex)
        {
            Log.ForContext<CalibrationPageView>().Error(ex, "Card-scan file picker failed.");
            vm.StatusText = $"Could not open the file picker: {ex.Message}";
        }
    }
}
