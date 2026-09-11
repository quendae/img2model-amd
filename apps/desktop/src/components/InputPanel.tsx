interface InputPanelProps {
  inputPath: string | null;
  previewUrl: string | null;
  onChoose: () => void;
  onClear: () => void;
}

export function InputPanel({ inputPath, previewUrl, onChoose, onClear }: InputPanelProps) {
  const fileName = inputPath?.split(/[\\/]/).pop();

  return (
    <section className="panel input-panel" aria-labelledby="input-heading">
      <div className="panel-heading">
        <div>
          <h2 id="input-heading">Source image</h2>
          <p>PNG, JPG or WEBP · one object works best</p>
        </div>
      </div>

      <div className={`image-drop ${previewUrl ? 'has-image' : ''}`}>
        {previewUrl ? (
          <img src={previewUrl} alt="Selected source" />
        ) : (
          <div className="empty-input">
            <span className="input-mark" aria-hidden="true">+</span>
            <strong>Select an image</strong>
            <small>Use a clean view with the subject fully visible.</small>
          </div>
        )}
      </div>

      {fileName && <div className="file-name" title={inputPath ?? undefined}>{fileName}</div>}

      <div className="button-row">
        <button type="button" className="secondary-button" onClick={onChoose}>
          {inputPath ? 'Change image' : 'Choose image'}
        </button>
        {inputPath && (
          <button type="button" className="ghost-button" onClick={onClear}>Clear</button>
        )}
      </div>
    </section>
  );
}
