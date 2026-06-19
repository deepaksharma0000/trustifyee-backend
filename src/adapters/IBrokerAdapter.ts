import { IUser } from "../models/User";

export interface IBrokerAdapter {
  connect(user: IUser, authCodeOrCredentials: any): Promise<any>;
  refreshSession(user: IUser): Promise<any>;
  placeOrder(user: IUser, payload: any): Promise<any>;
  modifyOrder(user: IUser, orderId: string, payload: any): Promise<any>;
  cancelOrder(user: IUser, orderId: string, payload?: any): Promise<any>;
  getPositions(user: IUser): Promise<any>;
  getHoldings(user: IUser): Promise<any>;
  getFunds(user: IUser): Promise<any>;
  getOrders(user: IUser): Promise<any>;
  logout(user: IUser): Promise<any>;
}
