import CodeMirror from '@uiw/react-codemirror';
import { sql, MySQL, PostgreSQL } from '@codemirror/lang-sql';
import { sqlLightTheme } from './sqlTheme';
import type { DbType } from '../api';

export default function SqlEditor({
  value,
  onChange,
  dbType,
  onRun,
}: {
  value: string;
  onChange: (v: string) => void;
  dbType: DbType;
  onRun?: () => void;
}) {
  return (
    <div className="sql-editor-wrap">
      <CodeMirror
        value={value}
        minHeight="110px"
        maxHeight="38vh"
        theme={sqlLightTheme}
        extensions={[
          sql({
            dialect: dbType === 'mysql' ? MySQL : dbType === 'postgres' ? PostgreSQL : undefined,
          }),
        ]}
        onChange={onChange}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onRun?.();
          }
        }}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          autocompletion: true,
          bracketMatching: true,
        }}
      />
    </div>
  );
}
