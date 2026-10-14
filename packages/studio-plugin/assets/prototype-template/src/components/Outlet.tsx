import React from 'react';
import { Outlet as OriginalOutlet } from 'umi';

const Outlet = OriginalOutlet as unknown as React.FC;

export default Outlet;
