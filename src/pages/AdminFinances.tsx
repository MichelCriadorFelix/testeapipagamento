import React, { useEffect, useState } from 'react';
import { collection, query, orderBy, onSnapshot, addDoc, deleteDoc, doc, limit } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { FinanceEntry, Order } from '../types';
import { formatCurrency } from '../lib/utils';
import { format } from 'date-fns';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Trash2 } from 'lucide-react';

export default function AdminFinances() {
  const [finances, setFinances] = useState<FinanceEntry[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  
  // Form state
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<'fixed_cost' | 'variable_cost'>('fixed_cost');

  useEffect(() => {
    const unsubFinances = onSnapshot(query(collection(db, 'finances'), orderBy('date', 'desc'), limit(500)), (snapshot) => {
      setFinances(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as FinanceEntry)));
    });

    const unsubOrders = onSnapshot(query(collection(db, 'pix_test_orders'), orderBy('createdAt', 'desc'), limit(2000)), (snapshot) => {
      setOrders(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Order)));
    });

    return () => {
      unsubFinances();
      unsubOrders();
    };
  }, []);

  const handleAddCost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || !description) return;

    await addDoc(collection(db, 'finances'), {
      type,
      amount: parseFloat(amount),
      description,
      date: Date.now(),
      createdAt: Date.now()
    });

    setAmount('');
    setDescription('');
  };

  const handleDeleteCost = async (id: string) => {
    if (confirm('Remover este custo?')) {
      await deleteDoc(doc(db, 'finances', id));
    }
  };

  // Calculations
  const completedOrders = orders.filter(o => o.status === 'completed');
  const totalIncome = completedOrders.reduce((acc, o) => acc + o.total, 0);
  
  const totalFixedCosts = finances.filter(f => f.type === 'fixed_cost').reduce((acc, f) => acc + f.amount, 0);
  const totalVariableCosts = finances.filter(f => f.type === 'variable_cost').reduce((acc, f) => acc + f.amount, 0);
  const totalCosts = totalFixedCosts + totalVariableCosts;
  
  const netProfit = totalIncome - totalCosts;

  // Chart Data preparation (Simple monthly grouping for demo)
  const chartData = [
    { name: 'Receitas', value: totalIncome, fill: '#16a34a' },
    { name: 'Custos Fixos', value: totalFixedCosts, fill: '#dc2626' },
    { name: 'Custos Var.', value: totalVariableCosts, fill: '#ea580c' },
    { name: 'Lucro Líquido', value: Math.max(0, netProfit), fill: '#2563eb' }
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="text-xl font-black text-gray-900 mb-6 uppercase tracking-wider">CRM & Financeiro</h1>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 border-l-4 border-l-green-500">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Receita Total</p>
          <p className="text-xl font-black text-gray-900 mt-1">{formatCurrency(totalIncome)}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 border-l-4 border-l-red-500">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Custos Fixos</p>
          <p className="text-xl font-black text-gray-900 mt-1">{formatCurrency(totalFixedCosts)}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 border-l-4 border-l-orange-500">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Custos Variáveis</p>
          <p className="text-xl font-black text-gray-900 mt-1">{formatCurrency(totalVariableCosts)}</p>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 border-l-4 border-l-brand">
          <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold">Lucro Líquido</p>
          <p className={`text-xl font-black mt-1 ${netProfit >= 0 ? 'text-brand' : 'text-red-600'}`}>
            {formatCurrency(netProfit)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        {/* Chart */}
        <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-xs font-bold text-gray-900 mb-4 uppercase tracking-widest">Visão Geral</h2>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" />
                <YAxis />
                <Tooltip formatter={(value: number) => formatCurrency(value)} />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Add Cost Form */}
        <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
          <h2 className="text-xs font-bold text-gray-900 mb-4 uppercase tracking-widest">Lançar Despesa</h2>
          <form onSubmit={handleAddCost} className="space-y-3">
            <div>
              <label className="block text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1">Descrição</label>
              <input 
                type="text" 
                required 
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Ex: Conta de Luz, Ingredientes..."
                className="block w-full border border-gray-200 bg-gray-50 rounded-lg shadow-sm focus:ring-brand focus:border-brand p-2 text-xs" 
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1">Valor (R$)</label>
                <input 
                  type="number" 
                  step="0.01"
                  required
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  className="block w-full border border-gray-200 bg-gray-50 rounded-lg shadow-sm focus:ring-brand focus:border-brand p-2 text-xs" 
                />
              </div>
              <div>
                <label className="block text-[9px] font-bold text-gray-500 uppercase tracking-widest mb-1">Tipo</label>
                <select 
                  value={type}
                  onChange={e => setType(e.target.value as any)}
                  className="block w-full border border-gray-200 bg-gray-50 rounded-lg shadow-sm focus:ring-brand focus:border-brand p-2 text-xs"
                >
                  <option value="fixed_cost">Custo Fixo (Aluguel, Luz)</option>
                  <option value="variable_cost">Custo Variável (Ingredientes)</option>
                </select>
              </div>
            </div>
            <button type="submit" className="w-full bg-brand text-white py-2 px-4 rounded-lg hover:bg-brand-dark text-[10px] font-bold uppercase tracking-widest transition-colors shadow-sm mt-2">
              Adicionar Despesa
            </button>
          </form>
        </div>
      </div>

      {/* Costs List */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden border border-gray-100">
        <div className="px-5 py-3 border-b border-gray-100 bg-gray-50">
          <h2 className="text-xs font-bold text-gray-900 uppercase tracking-widest">Histórico de Despesas</h2>
        </div>
        {finances.length === 0 ? (
          <div className="p-6 text-center text-xs text-gray-500">Nenhuma despesa registrada.</div>
        ) : (
          <ul className="divide-y divide-gray-50">
            {finances.map(finance => (
              <li key={finance.id} className="px-5 py-3 flex justify-between items-center hover:bg-gray-50 transition-colors">
                <div>
                  <p className="text-xs font-bold text-gray-900 leading-tight">{finance.description}</p>
                  <p className="text-[9px] text-gray-500 uppercase tracking-widest font-bold mt-0.5">{format(new Date(finance.date), 'dd/MM/yyyy')} • {finance.type === 'fixed_cost' ? 'Custo Fixo' : 'Custo Variável'}</p>
                </div>
                <div className="flex items-center space-x-3">
                  <span className="font-black text-gray-900 text-sm">{formatCurrency(finance.amount)}</span>
                  <button onClick={() => handleDeleteCost(finance.id)} className="text-gray-400 hover:text-red-600 p-1 rounded hover:bg-red-50 transition-colors">
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
