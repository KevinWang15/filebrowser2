import { createContext, useContext } from 'react'

type Notify = (text: string, error?: boolean) => void
export const NotifyContext = createContext<Notify>(() => {})
export const useNotify = () => useContext(NotifyContext)
