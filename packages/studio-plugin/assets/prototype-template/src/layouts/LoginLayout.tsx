import React from 'react';
import { createStyles } from '@ead/antd-style';
import { Outlet } from '@/components';

const useStyles = createStyles(() => {
  return {
    'app-container': {
      height: '100%',
      padding: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
  };
});

const LoginLayout: React.FC = () => {
  const { styles } = useStyles();

  return (
    <div className={styles['app-container']}>
      <Outlet />
    </div>
  );
};

export default LoginLayout;
