import './revision-draft.css';

export function RevisionDraftConflict({ subject, changes, reload, rebase }: {
  subject: string; changes: readonly string[]; reload(): void; rebase(): void;
}): React.JSX.Element {
  return <section className="revision-draft-conflict" role="status" aria-label={`${subject}版本冲突`}>
    <strong>{subject}已更新，本地输入已保留。</strong>
    <ul>{changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
    <p>比较后选择重新载入，或保留输入并以当前版本继续编辑。</p>
    <div className="revision-draft-actions">
      <button type="button" onClick={reload}>重新载入{subject}</button>
      <button type="button" onClick={rebase}>保留输入，采用当前版本</button>
    </div>
  </section>;
}
