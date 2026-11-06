import React from 'react';
import { Flex, Spin } from '@ead/suid';

const Loading: React.FC = () => {
  return (
    <Flex justify="center" align="center" style={{ height: '100vh' }}>
      <Spin size="large" />
    </Flex>
  );
};

export default Loading;
