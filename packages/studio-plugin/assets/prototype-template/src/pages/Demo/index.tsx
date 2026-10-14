import React from 'react';
import { Button, ExtModal } from '@ead/suid';

const Demo: React.FC = () => {
  const [visible, setVisible] = React.useState(false);

  return (
    <div style={{ height: '100%' }}>
      <Button type="primary" onClick={() => setVisible(true)}>
        Click me
      </Button>
      <ExtModal
        title="Basic Modal"
        visible={visible}
        onOk={() => console.log('OK')}
        onCancel={() => setVisible(false)}
        destroyOnHidden
      >
        <p>Some contents...</p>
        <p>Some contents...</p>
        <p>Some contents...</p>
      </ExtModal>
    </div>
  );
};

export default Demo;
