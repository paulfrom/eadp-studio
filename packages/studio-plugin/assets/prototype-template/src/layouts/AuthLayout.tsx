import React, { useState } from 'react';
import { isEmpty } from 'lodash';
import { Link, history as umiHistory } from 'umi';
import { createStyles } from '@ead/antd-style';
import { Button, Flex, Layout, Menu } from '@ead/suid';
import { useUserContext } from '@ead/suid-utils-react';
import { Outlet } from '@/components';
import { constants } from '@/utils';
import routers from '../../config/router.config';

const useStyles = createStyles(() => {
  return {
    'app-container': {
      height: '100%',
      padding: 0,
      backgroundColor: 'transparent',
    },
    'page-box': {
      padding: 6,
    },
  };
});

const { Header, Content, Sider } = Layout;
const { SubMenu } = Menu;
const { IS_PRODUCTION } = constants;

const AuthLayout: React.FC = () => {
  const { styles } = useStyles();
  const { currentUser } = useUserContext();
  const [mkeys, setMkeys] = useState<string[]>([]);
  const [openKeys, setOpenKeys] = useState<string[]>(['/']);

  if (isEmpty(currentUser)) {
    umiHistory.replace({
      pathname: '/user/login',
    });
  }

  const handlerBackLogin = () => {
    umiHistory.replace({ pathname: '/user/login' });
  };

  const getMenuNavItemByMode = (item: any) => {
    return <Link to={item.path}> {item.title} </Link>;
  };

  const handlerMenuChange = ({ key }: any) => {
    const [, p] = key.split('/');
    setMkeys([`/${p}`, key]);
  };

  const handlerMenuOpenChange = (keys: string[]) => {
    setOpenKeys(keys);
  };

  // 递归渲染树形菜单
  const getMenuItems = (data: any[]) => {
    return data.map((item) => {
      if (!item.title || item.hideInMenu) {
        return undefined;
      }
      if (item.routes && item.routes.length) {
        const title = (
          <span>
            <span>{item.title} </span>
          </span>
        );

        return (
          <SubMenu title={title} key={item.path}>
            {getMenuItems(item.routes)}
          </SubMenu>
        );
      }

      return (
        <Menu.Item title={item.title} key={item.path}>
          {getMenuNavItemByMode(item)}
        </Menu.Item>
      );
    });
  };

  if (IS_PRODUCTION) {
    return <Outlet />;
  }

  return (
    <Layout className={styles['app-container']}>
      <Sider width={220}>
        <div
          style={{
            height: '100%',
            background: '#001529',
          }}
        >
          <Menu
            openKeys={openKeys}
            defaultOpenKeys={['/', '/moduleName', '/moduleName/chat']}
            onClick={handlerMenuChange}
            onOpenChange={handlerMenuOpenChange}
            selectedKeys={mkeys}
            mode="inline"
            theme="dark"
            inlineCollapsed={false}
          >
            {getMenuItems(routers)}
          </Menu>
        </div>
      </Sider>
      <Content>
        <Layout className="auto-height main-content">
          <Header style={{ backgroundColor: '#fff' }}>
            <Flex justify="space-between" align="center">
              <div style={{ color: '#000', fontSize: 16, fontWeight: 600 }}>
                {' '}
                {`您好，${currentUser?.userName || '未登录'}`}
              </div>
              <Button type="link" onClick={handlerBackLogin}>
                切换用户
              </Button>
            </Flex>
          </Header>
          <Content className={styles['page-box']}>
            <Outlet />
          </Content>
        </Layout>
      </Content>
    </Layout>
  );
};

export default AuthLayout;
