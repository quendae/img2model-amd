import { App } from './App';
import { AppErrorBoundary } from './components/AppErrorBoundary';

export function Root() {
  return (
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  );
}
