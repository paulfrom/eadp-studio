import React from 'react';
import { Link } from 'umi';
import { Button, Layout, Result } from '@ead/suid';
import { useUserContext } from '@ead/suid-utils-react';
import useStyles from './style';

const { Content } = Layout;

const Home: React.FC = () => {
  const { currentUser } = useUserContext();
  const { styles } = useStyles();
  return (
    <Layout className={styles.box}>
      <Content>
        <Result
          icon="EADP"
          title="欢迎来到本模块进行开发"
          subTitle="将复杂留给自己，把简单带给客户"
          extra={
            !currentUser && (
              <Button type="primary">
                <Link to="/user/login">去登录</Link>
              </Button>
            )
          }
        />
      </Content>
    </Layout>
  );
};

export default Home;
