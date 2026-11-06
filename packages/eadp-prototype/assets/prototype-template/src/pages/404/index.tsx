import React from 'react';
import { useLocation } from 'umi';
import { Button, Result } from '@ead/suid';

const NotFound: React.FC = () => {
  const location = useLocation();

  return (
    <Result
      status="404"
      title="404"
      subTitle={`抱歉，您访问的页面不存在：${location.pathname}`}
      extra={
        <Button type="primary" onClick={() => window.location.reload()}>
          刷新
        </Button>
      }
    />
  );
};

export default NotFound;
