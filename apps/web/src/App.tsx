import { Center, Loader } from '@mantine/core';
import { RouterProvider } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from './auth/AuthProvider';
import { makeRouter } from './router';
import type { MakeRouterHistory } from './router';

// history اختياري للاختبارات (تاريخ في الذاكرة). history is optional, for tests (an in-memory history).
export const App = ({ history }: { history?: MakeRouterHistory }) => {
  const { state } = useAuth();
  const ref = useRef(state);
  ref.current = state;
  const [router] = useState(() => makeRouter({ current: () => ref.current }, history));
  // تغيّر الجلسة (دخول/خروج/انتهاء) يعيد تقييم الحرّاس. A session change (sign-in/out/expiry) re-runs the guards.
  useEffect(() => {
    if (state.status !== 'loading') void router.invalidate();
  }, [state, router]);

  if (state.status === 'loading')
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  return <RouterProvider router={router} />;
};
